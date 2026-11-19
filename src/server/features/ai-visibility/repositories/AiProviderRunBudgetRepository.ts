import { and, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { runBatch } from "@/db/runBatch";
import {
  aiProviderRunBudgetLocks,
  aiProviderRunReservations,
} from "@/db/schema";

export const AI_PROVIDER_BUDGET_WINDOW_MS = 7 * 24 * 60 * 60_000;
export const AI_PROVIDER_GLOBAL_BUDGET_USD_CENTS = 800;
export const AI_PROVIDER_GLOBAL_BUDGET_USD_MICROS =
  AI_PROVIDER_GLOBAL_BUDGET_USD_CENTS * 10_000;

const GLOBAL_BUDGET_LOCK_ID = "provider-run-budget";

export interface AiProviderBudgetUsage {
  accountedUsdMicros: number;
  heldUsdMicros: number;
}

export type AiProviderRunBudgetAdmission =
  | {
      admitted: true;
      heldUsdMicros: number;
      usedUsdMicros: number;
      remainingUsdMicros: number;
    }
  | {
      admitted: false;
      reason:
        | "budget_exceeded"
        | "global_budget_exceeded"
        | "run_in_progress"
        | "unknown_outcome"
        | "reservation_mismatch"
        | "cost_ceiling_unavailable";
      heldUsdMicros: number;
      usedUsdMicros: number;
      remainingUsdMicros: number;
    };

function usageWindow(cutoff: string) {
  return or(
    inArray(aiProviderRunReservations.status, ["reserved", "unknown"]),
    and(
      eq(aiProviderRunReservations.status, "settled"),
      or(
        gte(aiProviderRunReservations.settledAt, cutoff),
        and(
          isNull(aiProviderRunReservations.settledAt),
          gte(aiProviderRunReservations.createdAt, cutoff),
        ),
      ),
    ),
  );
}

function usageTotalSql(cutoff: string, projectId?: string) {
  const window = usageWindow(cutoff);
  const filter = projectId
    ? and(window, eq(aiProviderRunReservations.projectId, projectId))
    : window;
  return sql<number>`COALESCE((
    SELECT SUM(
      CASE
        WHEN ${aiProviderRunReservations.status} = 'settled'
          THEN COALESCE(${aiProviderRunReservations.accountedUsdMicros}, ${aiProviderRunReservations.reservedUsdMicros})
        ELSE ${aiProviderRunReservations.reservedUsdMicros}
      END
    )
    FROM ${aiProviderRunReservations}
    WHERE ${filter}
  ), 0)`;
}

async function getBudgetUsage(projectId: string | undefined, now: number) {
  const cutoff = new Date(now - AI_PROVIDER_BUDGET_WINDOW_MS).toISOString();
  const rows = await db
    .select({
      status: aiProviderRunReservations.status,
      reservedUsdMicros: aiProviderRunReservations.reservedUsdMicros,
      accountedUsdMicros: aiProviderRunReservations.accountedUsdMicros,
    })
    .from(aiProviderRunReservations)
    .where(
      projectId
        ? and(
            usageWindow(cutoff),
            eq(aiProviderRunReservations.projectId, projectId),
          )
        : usageWindow(cutoff),
    );
  return rows.reduce(
    (usage, row) => {
      if (row.status === "settled")
        usage.accountedUsdMicros +=
          row.accountedUsdMicros ?? row.reservedUsdMicros;
      else usage.heldUsdMicros += row.reservedUsdMicros;
      return usage;
    },
    { accountedUsdMicros: 0, heldUsdMicros: 0 },
  );
}

/** Provider-reported totals count for seven days; unresolved holds never expire. */
export async function getAiProviderBudgetUsage(
  projectId: string,
  now = Date.now(),
): Promise<AiProviderBudgetUsage> {
  return getBudgetUsage(projectId, now);
}

/** Provider-neutral usage shared by every project on this installation. */
export async function getAiProviderGlobalBudgetUsage(
  now = Date.now(),
): Promise<AiProviderBudgetUsage> {
  return getBudgetUsage(undefined, now);
}

/**
 * Reserve the full provider-cost ceiling before any provider call. A global
 * lock serializes D1 and Postgres admissions while the SQL insert enforces both
 * the project cap and provider-neutral installation cap in the same transaction.
 */
export async function reserveAiProviderRunBudget(input: {
  id: string;
  projectId: string;
  runId: string;
  limitUsdCents: number;
  reserveUsdMicros: number;
  createdAt: string;
}): Promise<AiProviderRunBudgetAdmission> {
  const limitUsdMicros = input.limitUsdCents * 10_000;
  if (
    !Number.isSafeInteger(input.reserveUsdMicros) ||
    input.reserveUsdMicros <= 0 ||
    !Number.isSafeInteger(limitUsdMicros) ||
    limitUsdMicros < 0
  )
    return {
      admitted: false,
      reason: "budget_exceeded",
      heldUsdMicros: input.reserveUsdMicros,
      usedUsdMicros: 0,
      remainingUsdMicros: Math.max(limitUsdMicros, 0),
    };

  const sameRun = await db
    .select({
      projectId: aiProviderRunReservations.projectId,
      status: aiProviderRunReservations.status,
      reservedUsdMicros: aiProviderRunReservations.reservedUsdMicros,
    })
    .from(aiProviderRunReservations)
    .where(eq(aiProviderRunReservations.runId, input.runId))
    .limit(1);
  if (sameRun[0]) {
    if (
      sameRun[0].projectId !== input.projectId ||
      sameRun[0].reservedUsdMicros !== input.reserveUsdMicros
    )
      return {
        admitted: false,
        reason: "reservation_mismatch",
        heldUsdMicros: sameRun[0].reservedUsdMicros,
        usedUsdMicros: sameRun[0].reservedUsdMicros,
        remainingUsdMicros: 0,
      };
    if (sameRun[0].status !== "reserved")
      return {
        admitted: false,
        reason: "unknown_outcome",
        heldUsdMicros: sameRun[0].reservedUsdMicros,
        usedUsdMicros: sameRun[0].reservedUsdMicros,
        remainingUsdMicros: 0,
      };
    return {
      admitted: true,
      heldUsdMicros: sameRun[0].reservedUsdMicros,
      usedUsdMicros: 0,
      remainingUsdMicros: 0,
    };
  }

  const now = Date.parse(input.createdAt);
  const cutoff = new Date(now - AI_PROVIDER_BUDGET_WINDOW_MS).toISOString();
  const projectFits = sql`${usageTotalSql(cutoff, input.projectId)} + ${input.reserveUsdMicros} <= ${limitUsdMicros}`;
  const globalFits = sql`${usageTotalSql(cutoff)} + ${input.reserveUsdMicros} <= ${AI_PROVIDER_GLOBAL_BUDGET_USD_MICROS}`;

  // The upsert obtains a transaction-scoped row lock in Postgres. D1's atomic
  // batch serializes the same lock-and-insert sequence. The conditional insert
  // reads usage only after that global admission lock has been acquired.
  await runBatch((tx) => [
    tx
      .insert(aiProviderRunBudgetLocks)
      .values({ id: GLOBAL_BUDGET_LOCK_ID, version: 1 })
      .onConflictDoUpdate({
        target: aiProviderRunBudgetLocks.id,
        set: { version: sql`${aiProviderRunBudgetLocks.version} + 1` },
      }),
    tx
      .insert(aiProviderRunReservations)
      .select(
        tx
          .select({
            id: sql<string>`${input.id}`.as("id"),
            projectId: sql<string>`${input.projectId}`.as("project_id"),
            runId: sql<string>`${input.runId}`.as("run_id"),
            reservedUsdMicros: sql<number>`${input.reserveUsdMicros}`.as(
              "reserved_usd_micros",
            ),
            accountedUsdMicros: sql<number | null>`NULL`.as(
              "accounted_usd_micros",
            ),
            status: sql<"reserved">`'reserved'`.as("status"),
            createdAt: sql<string>`${input.createdAt}`.as("created_at"),
            settledAt: sql<string | null>`NULL`.as("settled_at"),
            reconciliationReference: sql<string | null>`NULL`.as(
              "reconciliation_reference",
            ),
            reconciledAt: sql<string | null>`NULL`.as("reconciled_at"),
          })
          .from(aiProviderRunBudgetLocks)
          .where(
            and(
              eq(aiProviderRunBudgetLocks.id, GLOBAL_BUDGET_LOCK_ID),
              projectFits,
              globalFits,
            ),
          ),
      )
      .onConflictDoNothing(),
  ]);

  const currentRun = await db
    .select({
      id: aiProviderRunReservations.id,
      projectId: aiProviderRunReservations.projectId,
      status: aiProviderRunReservations.status,
      reservedUsdMicros: aiProviderRunReservations.reservedUsdMicros,
    })
    .from(aiProviderRunReservations)
    .where(eq(aiProviderRunReservations.runId, input.runId))
    .limit(1);
  if (currentRun[0]) {
    if (
      currentRun[0].projectId !== input.projectId ||
      currentRun[0].reservedUsdMicros !== input.reserveUsdMicros
    )
      return {
        admitted: false,
        reason: "reservation_mismatch",
        heldUsdMicros: currentRun[0].reservedUsdMicros,
        usedUsdMicros: currentRun[0].reservedUsdMicros,
        remainingUsdMicros: 0,
      };
    if (currentRun[0].status !== "reserved")
      return {
        admitted: false,
        reason: "unknown_outcome",
        heldUsdMicros: currentRun[0].reservedUsdMicros,
        usedUsdMicros: currentRun[0].reservedUsdMicros,
        remainingUsdMicros: 0,
      };

    const [globalUsage, projectUsage] = await Promise.all([
      getAiProviderGlobalBudgetUsage(now),
      getAiProviderBudgetUsage(input.projectId, now),
    ]);
    const globalUsed =
      globalUsage.accountedUsdMicros + globalUsage.heldUsdMicros;
    const projectUsed =
      projectUsage.accountedUsdMicros + projectUsage.heldUsdMicros;
    if (
      globalUsed > AI_PROVIDER_GLOBAL_BUDGET_USD_MICROS ||
      projectUsed > limitUsdMicros
    ) {
      // If a concurrent status change or database trigger introduced another
      // hold during admission, release only this not-yet-dispatched hold.
      await db
        .update(aiProviderRunReservations)
        .set({ status: "released" })
        .where(
          and(
            eq(aiProviderRunReservations.id, currentRun[0].id),
            eq(aiProviderRunReservations.status, "reserved"),
          ),
        );
      const [latestGlobal, latestProject] = await Promise.all([
        getAiProviderGlobalBudgetUsage(now),
        getAiProviderBudgetUsage(input.projectId, now),
      ]);
      const used =
        latestProject.accountedUsdMicros + latestProject.heldUsdMicros;
      const globalLatestUsed =
        latestGlobal.accountedUsdMicros + latestGlobal.heldUsdMicros;
      const reason =
        used + input.reserveUsdMicros > limitUsdMicros
          ? "budget_exceeded"
          : "global_budget_exceeded";
      return {
        admitted: false,
        reason,
        heldUsdMicros: input.reserveUsdMicros,
        usedUsdMicros: used,
        remainingUsdMicros: Math.max(
          Math.min(
            limitUsdMicros - used,
            AI_PROVIDER_GLOBAL_BUDGET_USD_MICROS - globalLatestUsed,
          ),
          0,
        ),
      };
    }
    return {
      admitted: true,
      heldUsdMicros: currentRun[0].reservedUsdMicros,
      usedUsdMicros: Math.max(projectUsed - currentRun[0].reservedUsdMicros, 0),
      remainingUsdMicros: Math.max(
        Math.min(
          limitUsdMicros - projectUsed,
          AI_PROVIDER_GLOBAL_BUDGET_USD_MICROS - globalUsed,
        ),
        0,
      ),
    };
  }

  const [globalUsage, projectUsage, activeProjectReservation] =
    await Promise.all([
      getAiProviderGlobalBudgetUsage(now),
      getAiProviderBudgetUsage(input.projectId, now),
      db
        .select({ id: aiProviderRunReservations.id })
        .from(aiProviderRunReservations)
        .where(
          and(
            eq(aiProviderRunReservations.projectId, input.projectId),
            eq(aiProviderRunReservations.status, "reserved"),
          ),
        )
        .limit(1),
    ]);
  const globalUsed = globalUsage.accountedUsdMicros + globalUsage.heldUsdMicros;
  const projectUsed =
    projectUsage.accountedUsdMicros + projectUsage.heldUsdMicros;
  const remainingUsdMicros = Math.max(
    Math.min(
      limitUsdMicros - projectUsed,
      AI_PROVIDER_GLOBAL_BUDGET_USD_MICROS - globalUsed,
    ),
    0,
  );
  const common = {
    heldUsdMicros: input.reserveUsdMicros,
    usedUsdMicros: projectUsed,
    remainingUsdMicros,
  };
  if (activeProjectReservation[0])
    return { admitted: false, reason: "run_in_progress", ...common };
  if (projectUsed + input.reserveUsdMicros > limitUsdMicros)
    return { admitted: false, reason: "budget_exceeded", ...common };
  if (
    globalUsed + input.reserveUsdMicros >
    AI_PROVIDER_GLOBAL_BUDGET_USD_MICROS
  )
    return { admitted: false, reason: "global_budget_exceeded", ...common };

  // A missing row after a passing calculation means the run was not persisted.
  // Fail closed; never let workflow execution proceed without a durable hold.
  return { admitted: false, reason: "run_in_progress", ...common };
}

/** A confirmed workflow completion settles at the provider-reported charge. */
export async function settleAiProviderRunBudget(
  runId: string,
  accountedUsdMicros: number,
  settledAt: string,
) {
  if (!Number.isSafeInteger(accountedUsdMicros) || accountedUsdMicros < 0)
    throw new Error("Provider budget settled amount is invalid.");
  const reservation = await db
    .select()
    .from(aiProviderRunReservations)
    .where(eq(aiProviderRunReservations.runId, runId))
    .limit(1);
  if (!reservation[0] || reservation[0].status !== "reserved") return;
  await db
    .update(aiProviderRunReservations)
    .set({
      status: "settled",
      accountedUsdMicros,
      settledAt,
    })
    .where(
      and(
        eq(aiProviderRunReservations.id, reservation[0].id),
        eq(aiProviderRunReservations.status, "reserved"),
      ),
    );
}

export {
  markAiProviderRunBudgetUnknown,
  listUnknownAiProviderRunBudgets,
  reconcileAiProviderRunBudget,
  releaseAiProviderRunBudget,
  type AiProviderRunBudgetReconciliationInput,
  type AiProviderRunBudgetReconciliationResult,
} from "./AiProviderRunBudgetRecoveryRepository";

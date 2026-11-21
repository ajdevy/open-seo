import { and, eq, exists, sql } from "drizzle-orm";
import { db } from "@/db";
import { getBatchRows, runBatchWithResults } from "@/db/runBatch";
import {
  AI_PROVIDER_BUDGET_WINDOW_MS,
  AI_PROVIDER_GLOBAL_BUDGET_USD_MICROS,
  getAiProviderBudgetUsage,
  getAiProviderGlobalBudgetUsage,
  usageTotalSql,
} from "./AiProviderRunBudgetUsageRepository";
export {
  AI_PROVIDER_BUDGET_WINDOW_MS,
  AI_PROVIDER_GLOBAL_BUDGET_USD_CENTS,
  AI_PROVIDER_GLOBAL_BUDGET_USD_MICROS,
  getAiProviderBudgetUsage,
  getAiProviderGlobalBudgetUsage,
  type AiProviderBudgetUsage,
} from "./AiProviderRunBudgetUsageRepository";
import {
  aiTrackers,
  aiProviderRunBudgetLocks,
  aiProviderRunReservations,
} from "@/db/schema";

const GLOBAL_BUDGET_LOCK_ID = "provider-run-budget";
export type AiProviderRunBudgetTransaction = Parameters<
  Parameters<typeof runBatchWithResults>[0]
>[0];

/** Serialize saved project budget changes with provider-run admissions. */
export function lockAiProviderRunBudget(tx: AiProviderRunBudgetTransaction) {
  return tx
    .insert(aiProviderRunBudgetLocks)
    .values({ id: GLOBAL_BUDGET_LOCK_ID, version: 1 })
    .onConflictDoUpdate({
      target: aiProviderRunBudgetLocks.id,
      set: { version: sql`${aiProviderRunBudgetLocks.version} + 1` },
    });
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
        | "budget_changed"
        | "cost_ceiling_unavailable";
      heldUsdMicros: number;
      usedUsdMicros: number;
      remainingUsdMicros: number;
    };

function reservationRejected(
  reason: "reservation_mismatch" | "unknown_outcome",
  heldUsdMicros: number,
): AiProviderRunBudgetAdmission {
  return {
    admitted: false,
    reason,
    heldUsdMicros,
    usedUsdMicros: heldUsdMicros,
    remainingUsdMicros: 0,
  };
}

/**
 * Reserve the full provider-cost ceiling before any provider call. A global
 * lock serializes D1 and Postgres admissions and saved budget changes while the
 * SQL insert enforces the current project cap and installation cap atomically.
 */
export async function reserveAiProviderRunBudget(
  input: {
    id: string;
    projectId: string;
    runId: string;
    limitUsdCents: number;
    reserveUsdMicros: number;
    createdAt: string;
  },
  budgetWindowNow = Date.now(),
): Promise<AiProviderRunBudgetAdmission> {
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
      return reservationRejected(
        "reservation_mismatch",
        sameRun[0].reservedUsdMicros,
      );
    if (sameRun[0].status !== "reserved")
      return reservationRejected(
        "unknown_outcome",
        sameRun[0].reservedUsdMicros,
      );
  }

  const cutoff = new Date(
    budgetWindowNow - AI_PROVIDER_BUDGET_WINDOW_MS,
  ).toISOString();
  const now = budgetWindowNow;
  const projectFits = sql`${usageTotalSql(cutoff, input.projectId)} + ${input.reserveUsdMicros} <= ${limitUsdMicros}`;
  const globalFits = sql`${usageTotalSql(cutoff)} + ${input.reserveUsdMicros} <= ${AI_PROVIDER_GLOBAL_BUDGET_USD_MICROS}`;
  const savedBudgetMatches = (tx: AiProviderRunBudgetTransaction) =>
    exists(
      tx
        .select({ id: aiTrackers.id })
        .from(aiTrackers)
        .where(
          and(
            eq(aiTrackers.projectId, input.projectId),
            eq(aiTrackers.weeklyProviderBudgetCents, input.limitUsdCents),
          ),
        ),
    );

  // The upsert obtains a transaction-scoped row lock in Postgres. D1's atomic
  // batch serializes the same lock-and-insert sequence. The conditional insert
  // reads usage only after that global admission lock has been acquired.
  const batchResults = await runBatchWithResults((tx) => [
    lockAiProviderRunBudget(tx),
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
              savedBudgetMatches(tx),
              projectFits,
              globalFits,
            ),
          ),
      )
      .onConflictDoNothing()
      .returning({ id: aiProviderRunReservations.id }),
  ]);
  const ownsNewReservation = getBatchRows(batchResults[1]).some(
    (row) =>
      typeof row === "object" &&
      row !== null &&
      "id" in row &&
      row.id === input.id,
  );

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
      return reservationRejected(
        "reservation_mismatch",
        currentRun[0].reservedUsdMicros,
      );
    if (currentRun[0].status !== "reserved")
      return reservationRejected(
        "unknown_outcome",
        currentRun[0].reservedUsdMicros,
      );

    // If the row appeared after pre-read under another ID, another caller owns
    // the hold; neither admit this dispatch nor release that reservation.
    if (!sameRun[0] && !ownsNewReservation)
      return {
        admitted: false,
        reason: "run_in_progress",
        heldUsdMicros: currentRun[0].reservedUsdMicros,
        usedUsdMicros: currentRun[0].reservedUsdMicros,
        remainingUsdMicros: 0,
      };

    const [globalUsage, projectUsage, savedBudgetRows] = await Promise.all([
      getAiProviderGlobalBudgetUsage(now),
      getAiProviderBudgetUsage(input.projectId, now),
      db
        .select({
          weeklyProviderBudgetCents: aiTrackers.weeklyProviderBudgetCents,
        })
        .from(aiTrackers)
        .where(eq(aiTrackers.projectId, input.projectId))
        .limit(1),
    ]);
    const globalUsed =
      globalUsage.accountedUsdMicros + globalUsage.heldUsdMicros;
    const projectUsed =
      projectUsage.accountedUsdMicros + projectUsage.heldUsdMicros;
    const savedLimitUsdCents = savedBudgetRows[0]?.weeklyProviderBudgetCents;
    if (savedLimitUsdCents !== input.limitUsdCents)
      return {
        admitted: false,
        reason: "budget_changed",
        heldUsdMicros: currentRun[0].reservedUsdMicros,
        usedUsdMicros: Math.max(
          projectUsed - currentRun[0].reservedUsdMicros,
          0,
        ),
        remainingUsdMicros: Math.max(
          Math.min(
            (savedLimitUsdCents ?? 0) * 10_000 - projectUsed,
            AI_PROVIDER_GLOBAL_BUDGET_USD_MICROS - globalUsed,
          ),
          0,
        ),
      };
    if (
      globalUsed > AI_PROVIDER_GLOBAL_BUDGET_USD_MICROS ||
      projectUsed > limitUsdMicros
    ) {
      if (!ownsNewReservation) {
        // This is an idempotent retry of an existing hold. Its provider
        // request may already have started, so do not release it. The same
        // applies to any row not inserted by this call.
        return {
          admitted: false,
          reason:
            projectUsed > limitUsdMicros
              ? "budget_exceeded"
              : "global_budget_exceeded",
          heldUsdMicros: currentRun[0].reservedUsdMicros,
          usedUsdMicros: Math.max(
            projectUsed - currentRun[0].reservedUsdMicros,
            0,
          ),
          remainingUsdMicros: Math.max(
            Math.min(
              limitUsdMicros - projectUsed,
              AI_PROVIDER_GLOBAL_BUDGET_USD_MICROS - globalUsed,
            ),
            0,
          ),
        };
      }

      // This row was created by this call, before any provider request. A
      // concurrent hold made admission fail, so only this new hold is safe to
      // release.
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

  const [globalUsage, projectUsage, activeProjectReservation, savedBudgetRows] =
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
      db
        .select({
          weeklyProviderBudgetCents: aiTrackers.weeklyProviderBudgetCents,
        })
        .from(aiTrackers)
        .where(eq(aiTrackers.projectId, input.projectId))
        .limit(1),
    ]);
  const globalUsed = globalUsage.accountedUsdMicros + globalUsage.heldUsdMicros;
  const projectUsed =
    projectUsage.accountedUsdMicros + projectUsage.heldUsdMicros;
  const savedLimitUsdCents = savedBudgetRows[0]?.weeklyProviderBudgetCents;
  const savedLimitUsdMicros = (savedLimitUsdCents ?? 0) * 10_000;
  const remainingUsdMicros = Math.max(
    Math.min(
      savedLimitUsdMicros - projectUsed,
      AI_PROVIDER_GLOBAL_BUDGET_USD_MICROS - globalUsed,
    ),
    0,
  );
  const common = {
    heldUsdMicros: input.reserveUsdMicros,
    usedUsdMicros: projectUsed,
    remainingUsdMicros,
  };
  if (savedLimitUsdCents !== input.limitUsdCents)
    return { admitted: false, reason: "budget_changed", ...common };
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

export {
  hasReservedAiProviderRunBudget,
  settleAiProviderRunBudget,
} from "./AiProviderRunBudgetSettlementRepository";

export {
  markAiProviderRunBudgetUnknown,
  listUnknownAiProviderRunBudgets,
  reconcileAiProviderRunBudget,
  releaseAiProviderRunBudget,
  type AiProviderRunBudgetReconciliationInput,
  type AiProviderRunBudgetReconciliationResult,
} from "./AiProviderRunBudgetRecoveryRepository";

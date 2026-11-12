import { and, eq, gte, inArray, isNull, or } from "drizzle-orm";
import { db } from "@/db";
import { aiProviderRunReservations } from "@/db/schema";

export const AI_PROVIDER_BUDGET_WINDOW_MS = 7 * 24 * 60 * 60_000;

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
      reason: "budget_exceeded" | "run_in_progress" | "unknown_outcome";
      heldUsdMicros: number;
      usedUsdMicros: number;
      remainingUsdMicros: number;
    };

/** Settled upper bounds count for seven days; unresolved holds never expire. */
export async function getAiProviderBudgetUsage(
  projectId: string,
  now = Date.now(),
): Promise<AiProviderBudgetUsage> {
  const cutoff = new Date(now - AI_PROVIDER_BUDGET_WINDOW_MS).toISOString();
  const rows = await db
    .select({
      status: aiProviderRunReservations.status,
      reservedUsdMicros: aiProviderRunReservations.reservedUsdMicros,
      accountedUsdMicros: aiProviderRunReservations.accountedUsdMicros,
    })
    .from(aiProviderRunReservations)
    .where(
      and(
        eq(aiProviderRunReservations.projectId, projectId),
        or(
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
        ),
      ),
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

/**
 * Reserves a run's conservative provider-cost ceiling before its workflow can
 * make any provider calls. The active-run index serializes admissions per
 * project; a run cannot proceed unless its full upper bound fits.
 */
export async function reserveAiProviderRunBudget(input: {
  id: string;
  projectId: string;
  runId: string;
  limitUsdCents: number;
  reserveUsdMicros: number;
  createdAt: string;
}): Promise<AiProviderRunBudgetAdmission> {
  const existing = await db
    .select()
    .from(aiProviderRunReservations)
    .where(eq(aiProviderRunReservations.runId, input.runId))
    .limit(1);
  if (existing[0]?.status === "reserved")
    return {
      admitted: true,
      heldUsdMicros: existing[0].reservedUsdMicros,
      usedUsdMicros: 0,
      remainingUsdMicros: 0,
    };
  if (existing[0])
    return {
      admitted: false,
      reason: "unknown_outcome",
      heldUsdMicros: existing[0].reservedUsdMicros,
      usedUsdMicros: existing[0].reservedUsdMicros,
      remainingUsdMicros: 0,
    };

  const usage = await getAiProviderBudgetUsage(
    input.projectId,
    Date.parse(input.createdAt),
  );
  const usedUsdMicros = usage.accountedUsdMicros + usage.heldUsdMicros;
  const limitUsdMicros = input.limitUsdCents * 10_000;
  if (
    !Number.isSafeInteger(input.reserveUsdMicros) ||
    input.reserveUsdMicros <= 0 ||
    !Number.isSafeInteger(limitUsdMicros) ||
    input.reserveUsdMicros + usedUsdMicros > limitUsdMicros
  )
    return {
      admitted: false,
      reason: "budget_exceeded",
      heldUsdMicros: input.reserveUsdMicros,
      usedUsdMicros,
      remainingUsdMicros: Math.max(limitUsdMicros - usedUsdMicros, 0),
    };

  const inserted = await db
    .insert(aiProviderRunReservations)
    .values({
      id: input.id,
      projectId: input.projectId,
      runId: input.runId,
      reservedUsdMicros: input.reserveUsdMicros,
      status: "reserved",
      createdAt: input.createdAt,
    })
    .onConflictDoNothing()
    .returning({ id: aiProviderRunReservations.id });
  // A second tracker/run in the same project may have won the admission race.
  // The unique active-project index makes this a safe denial, never an overrun.
  if (inserted.length === 0) {
    const sameRun = await db
      .select({
        status: aiProviderRunReservations.status,
        reservedUsdMicros: aiProviderRunReservations.reservedUsdMicros,
      })
      .from(aiProviderRunReservations)
      .where(eq(aiProviderRunReservations.runId, input.runId))
      .limit(1);
    if (sameRun[0]?.status === "reserved")
      return {
        admitted: true,
        heldUsdMicros: sameRun[0].reservedUsdMicros,
        usedUsdMicros: 0,
        remainingUsdMicros: 0,
      };
    const latestUsage = await getAiProviderBudgetUsage(
      input.projectId,
      Date.parse(input.createdAt),
    );
    const latestUsed =
      latestUsage.accountedUsdMicros + latestUsage.heldUsdMicros;
    return {
      admitted: false,
      reason: "run_in_progress",
      heldUsdMicros: input.reserveUsdMicros,
      usedUsdMicros: latestUsed,
      remainingUsdMicros: Math.max(limitUsdMicros - latestUsed, 0),
    };
  }

  // Another reservation may have changed from reserved to unknown or settled
  // after our initial usage read, which removes it from the active-run index.
  // Re-read after inserting our hold so that race cannot admit spend over cap.
  const admittedUsage = await getAiProviderBudgetUsage(
    input.projectId,
    Date.parse(input.createdAt),
  );
  const admittedUsed =
    admittedUsage.accountedUsdMicros + admittedUsage.heldUsdMicros;
  const otherUsed = admittedUsed - input.reserveUsdMicros;
  if (admittedUsed > limitUsdMicros) {
    // No provider call has started yet, so this reservation can be released.
    // A concurrent status change fails closed: the row remains accounted.
    await db
      .update(aiProviderRunReservations)
      .set({ status: "released" })
      .where(
        and(
          eq(aiProviderRunReservations.id, input.id),
          eq(aiProviderRunReservations.status, "reserved"),
        ),
      );
    return {
      admitted: false,
      reason: "budget_exceeded",
      heldUsdMicros: input.reserveUsdMicros,
      usedUsdMicros: otherUsed,
      remainingUsdMicros: Math.max(limitUsdMicros - otherUsed, 0),
    };
  }
  return {
    admitted: true,
    heldUsdMicros: input.reserveUsdMicros,
    usedUsdMicros: otherUsed,
    remainingUsdMicros: limitUsdMicros - admittedUsed,
  };
}

/** A confirmed workflow completion settles at the reserved upper bound. */
export async function settleAiProviderRunBudget(
  runId: string,
  settledAt: string,
) {
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
      accountedUsdMicros: reservation[0].reservedUsdMicros,
      settledAt,
    })
    .where(
      and(
        eq(aiProviderRunReservations.id, reservation[0].id),
        eq(aiProviderRunReservations.status, "reserved"),
      ),
    );
}

/** A provider outcome is ambiguous; retain its full hold past the window. */
export async function markAiProviderRunBudgetUnknown(runId: string) {
  await db
    .update(aiProviderRunReservations)
    .set({ status: "unknown" })
    .where(
      and(
        eq(aiProviderRunReservations.runId, runId),
        eq(aiProviderRunReservations.status, "reserved"),
      ),
    );
}

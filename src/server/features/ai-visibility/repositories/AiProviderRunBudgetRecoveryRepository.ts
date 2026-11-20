import {
  and,
  eq,
  exists,
  isNull,
  lt,
  notInArray,
  notExists,
  or,
} from "drizzle-orm";
import { db } from "@/db";
import { aiProviderRunReservations, aiRuns } from "@/db/schema";

// The workflow can keep collecting late provider answers for almost a day.
// Keep terminal holds reserved through that window plus a short settlement
// retry margin, independent of which provider handled the run.
export const AI_PROVIDER_RUN_SETTLEMENT_GRACE_MS =
  24 * 60 * 60_000 + 5 * 60_000;

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

/** Release a hold only when the workflow proves no provider dispatch began. */
export async function releaseAiProviderRunBudget(runId: string) {
  await db
    .update(aiProviderRunReservations)
    .set({ status: "released" })
    .where(
      and(
        eq(aiProviderRunReservations.runId, runId),
        eq(aiProviderRunReservations.status, "reserved"),
      ),
    );
}

export type AiProviderRunBudgetReconciliationInput =
  | {
      runId: string;
      outcome: "settled";
      accountedUsdMicros: number;
      settledAt: string;
      evidenceReference: string;
      reconciledAt?: string;
    }
  | {
      runId: string;
      outcome: "released";
      evidenceReference: string;
      reconciledAt?: string;
    };

export type AiProviderRunBudgetReconciliationResult =
  | { reconciled: true; status: "settled" | "released" }
  | {
      reconciled: false;
      reason: "reservation_not_found" | "reservation_not_unknown";
    };

function normalizeReconciliationTime(value: string | undefined) {
  const time = value ?? new Date().toISOString();
  const parsed = Date.parse(time);
  if (!Number.isFinite(parsed))
    throw new Error("Provider budget reconciliation time is invalid.");
  return new Date(parsed).toISOString();
}

function validateEvidenceReference(value: string) {
  const reference = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,199}$/u.test(reference))
    throw new Error("Provider budget evidence reference is invalid.");
  return reference;
}

/**
 * Reconciles an unresolved provider hold using an operator-verified evidence
 * reference. Keep this server-internal: never expose it as a user-facing route.
 * Unknown holds are otherwise retained indefinitely and cannot be auto-released.
 */
export async function reconcileAiProviderRunBudget(
  input: AiProviderRunBudgetReconciliationInput,
): Promise<AiProviderRunBudgetReconciliationResult> {
  const evidenceReference = validateEvidenceReference(input.evidenceReference);
  const reconciledAt = normalizeReconciliationTime(input.reconciledAt);
  const settledAt =
    input.outcome === "settled"
      ? normalizeReconciliationTime(input.settledAt)
      : null;
  if (
    input.outcome === "settled" &&
    (!Number.isSafeInteger(input.accountedUsdMicros) ||
      input.accountedUsdMicros < 0)
  )
    throw new Error("Provider budget reconciled amount is invalid.");

  const selectReservation = () =>
    db
      .select({
        reservedUsdMicros: aiProviderRunReservations.reservedUsdMicros,
        accountedUsdMicros: aiProviderRunReservations.accountedUsdMicros,
        status: aiProviderRunReservations.status,
        settledAt: aiProviderRunReservations.settledAt,
        reconciliationReference:
          aiProviderRunReservations.reconciliationReference,
      })
      .from(aiProviderRunReservations)
      .where(eq(aiProviderRunReservations.runId, input.runId))
      .limit(1);

  const [reservation] = await selectReservation();
  if (!reservation)
    return { reconciled: false, reason: "reservation_not_found" };

  const isAlreadyReconciled =
    reservation.status === input.outcome &&
    reservation.reconciliationReference === evidenceReference &&
    (input.outcome === "released"
      ? reservation.accountedUsdMicros === 0 && reservation.settledAt === null
      : reservation.accountedUsdMicros === input.accountedUsdMicros &&
        reservation.settledAt === settledAt);
  if (isAlreadyReconciled) return { reconciled: true, status: input.outcome };
  if (reservation.status !== "unknown")
    return { reconciled: false, reason: "reservation_not_unknown" };

  const common = {
    reconciliationReference: evidenceReference,
    reconciledAt,
  };
  const values =
    input.outcome === "settled"
      ? {
          ...common,
          status: "settled" as const,
          accountedUsdMicros: input.accountedUsdMicros,
          settledAt,
        }
      : {
          ...common,
          status: "released" as const,
          accountedUsdMicros: 0,
          settledAt: null,
        };
  await db
    .update(aiProviderRunReservations)
    .set(values)
    .where(
      and(
        eq(aiProviderRunReservations.runId, input.runId),
        eq(aiProviderRunReservations.status, "unknown"),
        eq(
          aiProviderRunReservations.reservedUsdMicros,
          reservation.reservedUsdMicros,
        ),
      ),
    );

  const [updated] = await selectReservation();
  if (
    updated?.status === input.outcome &&
    updated.reconciliationReference === evidenceReference &&
    (input.outcome === "released"
      ? updated.accountedUsdMicros === 0 && updated.settledAt === null
      : updated.accountedUsdMicros === input.accountedUsdMicros &&
        updated.settledAt === settledAt)
  )
    return { reconciled: true, status: input.outcome };
  return { reconciled: false, reason: "reservation_not_unknown" };
}

/** Operator queue metadata only; never includes prompts, answers, or credentials. */
export async function listUnknownAiProviderRunBudgets(
  limit = 100,
  now = Date.now(),
) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new Error("Provider budget queue limit is invalid.");
  // Run deletion no longer cascades into the reservation ledger. Also
  // quarantine terminal runs only after the workflow's late-answer window and
  // settlement retries have elapsed; active and recent terminal runs can
  // still be collecting or settling and must keep their reserved status.
  const staleTerminalRunCutoff = new Date(
    now - AI_PROVIDER_RUN_SETTLEMENT_GRACE_MS,
  ).toISOString();
  await db
    .update(aiProviderRunReservations)
    .set({ status: "unknown" })
    .where(
      and(
        eq(aiProviderRunReservations.status, "reserved"),
        or(
          notExists(
            db
              .select({ id: aiRuns.id })
              .from(aiRuns)
              .where(eq(aiRuns.id, aiProviderRunReservations.runId)),
          ),
          exists(
            db
              .select({ id: aiRuns.id })
              .from(aiRuns)
              .where(
                and(
                  eq(aiRuns.id, aiProviderRunReservations.runId),
                  notInArray(aiRuns.status, ["queued", "running"]),
                  or(
                    lt(aiRuns.completedAt, staleTerminalRunCutoff),
                    and(
                      isNull(aiRuns.completedAt),
                      lt(aiRuns.createdAt, staleTerminalRunCutoff),
                    ),
                  ),
                ),
              ),
          ),
        ),
      ),
    );
  return db
    .select({
      runId: aiProviderRunReservations.runId,
      projectId: aiProviderRunReservations.projectId,
      reservedUsdMicros: aiProviderRunReservations.reservedUsdMicros,
      createdAt: aiProviderRunReservations.createdAt,
    })
    .from(aiProviderRunReservations)
    .where(eq(aiProviderRunReservations.status, "unknown"))
    .orderBy(aiProviderRunReservations.createdAt)
    .limit(limit);
}

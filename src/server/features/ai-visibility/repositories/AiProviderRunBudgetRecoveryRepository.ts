import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { aiProviderRunReservations } from "@/db/schema";

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
export async function listUnknownAiProviderRunBudgets(limit = 100) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new Error("Provider budget queue limit is invalid.");
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

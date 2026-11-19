import type { AiEngine } from "@/shared/ai-visibility";
import { reserveAiProviderRunBudget } from "../repositories/AiProviderRunBudgetRepository";
import type { RunRow } from "../repositories/AiVisibilityRepository";
import { aiCostForAnswers } from "./aiVisibilityCost";
import { markAiProviderRunBudgetUnknown } from "../repositories/AiProviderRunBudgetRecoveryRepository";

export function providerBudgetDenialMessage(
  reservationCost: number,
  admission: Awaited<ReturnType<typeof reserveAiProviderRunBudget>>,
) {
  if (admission.admitted) return null;
  if (admission.reason === "cost_ceiling_unavailable")
    return "This selection includes a provider route with variable token or web-search charges and no enforceable run ceiling. No provider request was started.";
  if (admission.reason === "run_in_progress")
    return "Another provider run already holds this project's active reservation. No provider request was started.";
  if (admission.reason === "unknown_outcome")
    return "This run has an unresolved provider outcome and cannot be started again until that outcome is reconciled.";
  if (admission.reason === "reservation_mismatch")
    return "A different provider-cost ceiling is already reserved for this run. No new provider request was started.";
  if (admission.reason === "global_budget_exceeded")
    return `This run may use up to $${reservationCost.toFixed(4)} in provider charges, but only $${(admission.remainingUsdMicros / 1e6).toFixed(4)} remains in the installation-wide rolling 7-day provider budget. No provider request was started.`;
  return `This run may use up to $${reservationCost.toFixed(4)} in provider charges, but only $${(admission.remainingUsdMicros / 1e6).toFixed(4)} remains in this project's rolling 7-day budget. No provider request was started.`;
}

/**
 * Reserves a full run ceiling before workflow creation. Repeating this with
 * the same run id is safe: an existing reserved row is admitted idempotently.
 */
export async function reserveProviderBudgetForRun(input: {
  run: Pick<RunRow, "id" | "projectId" | "trigger" | "createdAt">;
  limitUsdCents: number;
  engines: AiEngine[];
}) {
  const cost = aiCostForAnswers(
    input.engines,
    false,
    input.run.trigger === "scheduled" ? "queued" : "live",
  );
  const reservationCost = cost.providerCostUsd;
  if (!cost.providerCostBounded) {
    const admission = {
      admitted: false as const,
      reason: "cost_ceiling_unavailable" as const,
      heldUsdMicros: 0,
      usedUsdMicros: 0,
      remainingUsdMicros: 0,
    };
    return {
      admission,
      reservationCost,
      message: providerBudgetDenialMessage(reservationCost, admission),
    };
  }
  try {
    const admission = await reserveAiProviderRunBudget({
      id: crypto.randomUUID(),
      projectId: input.run.projectId,
      runId: input.run.id,
      limitUsdCents: input.limitUsdCents,
      reserveUsdMicros: Math.round(reservationCost * 1e6),
      createdAt: input.run.createdAt,
    });
    return {
      admission,
      reservationCost,
      message: providerBudgetDenialMessage(reservationCost, admission),
    };
  } catch (error) {
    // A lost database response could hide a committed reservation. Keep that
    // possible hold unresolved so a retry cannot dispatch without admission.
    await markAiProviderRunBudgetUnknown(input.run.id).catch(() => undefined);
    throw error;
  }
}

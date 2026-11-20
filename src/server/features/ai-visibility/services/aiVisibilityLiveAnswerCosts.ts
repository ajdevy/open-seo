import type { BillingCustomerContext } from "@/server/billing/subscription";
import { DataforseoChargedTaskError } from "@/server/lib/dataforseo/envelope";
import {
  createDataforseoClient,
  type AiTrackingAnswer,
} from "@/server/lib/dataforseo";
import { asAppError } from "@/server/lib/errors";
import type { AiEngine } from "@/shared/ai-visibility";

export interface AiProviderCostOutcome {
  providerCostUsd: number;
  providerCostKnown: boolean;
}

export interface AiLiveAnswerWithProviderCost extends AiProviderCostOutcome {
  answer: AiTrackingAnswer;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** A failed or ambiguous call retains its reservation unless billing is exact. */
export async function fetchAiLiveAnswersWithCosts(
  customer: BillingCustomerContext,
  market: { locationCode: number; languageCode: string },
  tasks: Array<{ engine: AiEngine; tag: string; prompt: string }>,
): Promise<AiLiveAnswerWithProviderCost[]> {
  let settled: PromiseSettledResult<{
    data: AiTrackingAnswer;
    providerCostUsd: number;
    providerCostKnown: boolean;
  }>[];
  try {
    settled = await createDataforseoClient(
      customer,
    ).aiSearch.trackingLiveBatchWithCosts(
      tasks.map(({ engine, tag, prompt }) => ({
        ...market,
        engine,
        task: { tag, prompt },
      })),
    );
  } catch (error) {
    settled = tasks.map(() => ({ status: "rejected", reason: error }));
  }
  return settled.map((outcome) => {
    if (outcome.status === "fulfilled") {
      const providerCostUsd = outcome.value.providerCostUsd;
      return {
        answer: outcome.value.data,
        providerCostUsd,
        providerCostKnown:
          outcome.value.providerCostKnown &&
          Number.isFinite(providerCostUsd) &&
          providerCostUsd >= 0,
      };
    }
    const chargedError =
      outcome.reason instanceof DataforseoChargedTaskError
        ? outcome.reason
        : null;
    const providerCostUsd = chargedError?.billing.costUsd ?? 0;
    return {
      answer: {
        status: "failed",
        message: errorMessage(outcome.reason),
        code: asAppError(outcome.reason)?.code ?? "INTERNAL_ERROR",
        retryable: false,
      },
      providerCostUsd,
      providerCostKnown:
        chargedError !== null &&
        chargedError.billing.costKnown !== false &&
        Number.isFinite(providerCostUsd) &&
        providerCostUsd >= 0,
    };
  });
}

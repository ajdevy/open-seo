import { AiVisibilityRepository as repo } from "../repositories/AiVisibilityRepository";
import { AiVisibilityError } from "./aiVisibilityErrors";
import { aiScope } from "./aiVisibilityConfiguration";
import { isHostedServerAuthMode } from "@/server/lib/runtime-env";
import {
  aiEngineUsesModelApi,
  AI_ENGINE_LABELS,
  AI_LIVE_RECORD_COST_USD,
  AI_PROVIDER_MAX_ATTEMPTS_PER_ANSWER,
  AI_RECORD_COST_USD,
  type AiCostEstimate,
  type AiEngine,
} from "@/shared/ai-visibility";
import { llmResponseUsd } from "@/server/lib/dataforseo/pricing";
import {
  AUTUMN_SEO_DATA_CREDITS_PER_USD,
  creditsForProviderUsd,
} from "@/shared/billing";
import { scheduledChecksPerMonth } from "@/shared/rank-tracking";
import type { EstimateAiCostInput } from "@/types/schemas/ai-visibility";
import { projectPatch } from "./aiVisibilityMutation";
import { hasDataforseoAccess } from "@/server/lib/provider-access";
import {
  AI_PROVIDER_GLOBAL_BUDGET_USD_CENTS,
  AI_PROVIDER_GLOBAL_BUDGET_USD_MICROS,
  getAiProviderBudgetUsage,
  getAiProviderGlobalBudgetUsage,
} from "../repositories/AiProviderRunBudgetRepository";

/** Raw provider cost for one answer and one attempt. */
function aiAnswerUsd(engine: AiEngine, mode: "live" | "queued") {
  if (aiEngineUsesModelApi(engine)) return llmResponseUsd(engine, true);
  return mode === "live" ? AI_LIVE_RECORD_COST_USD : AI_RECORD_COST_USD;
}

/**
 * Forecast for a check: three attempts per answer, in credits when hosted or
 * provider USD when self-hosted. `providerCostBounded` tells admission whether
 * this forecast is a verifiable ceiling for every selected route.
 */
export function aiCostForAnswers(
  engines: AiEngine[],
  hosted: boolean,
  mode: "live" | "queued",
) {
  let providerUsd = 0;
  let costCredits = 0;
  for (const engine of engines) {
    const usd = aiAnswerUsd(engine, mode);
    providerUsd += usd;
    costCredits += creditsForProviderUsd(usd);
  }
  const providerCostUsd =
    Math.round(providerUsd * 1e6 * AI_PROVIDER_MAX_ATTEMPTS_PER_ANSWER) / 1e6;
  return {
    providerCostUsd,
    // DataForSEO LLM Responses pricing varies with tokens and web-search
    // work. Historical per-answer observations are forecasts, not a hard cap.
    providerCostBounded: !engines.some(aiEngineUsesModelApi),
    costCredits: hosted ? costCredits * AI_PROVIDER_MAX_ATTEMPTS_PER_ANSWER : 0,
    costUsd: hosted
      ? (costCredits * AI_PROVIDER_MAX_ATTEMPTS_PER_ANSWER) /
        AUTUMN_SEO_DATA_CREDITS_PER_USD
      : providerCostUsd,
  };
}

export async function estimateCost(
  input: EstimateAiCostInput,
): Promise<AiCostEstimate> {
  const current = await repo.getConfiguration(input.projectId);
  const config = input.patch
    ? (await projectPatch(input.projectId, input.patch, current)).rows
    : current;
  if (!config)
    throw new AiVisibilityError(
      "TRACKER_REQUIRED",
      "Set your project's website and pass proposed prompts, or save tracking before estimating.",
    );
  const scope = aiScope(config, input.promptIds);
  const answers = scope.prompts.flatMap(() => scope.engines);
  const hosted = await isHostedServerAuthMode();
  const cost = aiCostForAnswers(answers, hosted, "queued");
  const runNow = aiCostForAnswers(answers, hosted, "live");
  const [projectUsage, globalUsage] = await Promise.all([
    getAiProviderBudgetUsage(input.projectId),
    getAiProviderGlobalBudgetUsage(),
  ]);
  const weeklyProviderBudgetUsd = AI_PROVIDER_GLOBAL_BUDGET_USD_CENTS / 100;
  const weeklyProviderBudgetAccountedUsd = globalUsage.accountedUsdMicros / 1e6;
  const weeklyProviderBudgetHeldUsd = globalUsage.heldUsdMicros / 1e6;
  const weeklyProviderBudgetGlobalAvailableUsdMicros = Math.max(
    AI_PROVIDER_GLOBAL_BUDGET_USD_MICROS -
      globalUsage.accountedUsdMicros -
      globalUsage.heldUsdMicros,
    0,
  );
  const weeklyProviderBudgetGlobalAvailableUsd =
    weeklyProviderBudgetGlobalAvailableUsdMicros / 1e6;
  const weeklyProjectProviderBudgetUsd =
    config.tracker.weeklyProviderBudgetCents / 100;
  const weeklyProjectProviderBudgetAccountedUsd =
    projectUsage.accountedUsdMicros / 1e6;
  const weeklyProjectProviderBudgetHeldUsd = projectUsage.heldUsdMicros / 1e6;
  const weeklyProjectProviderBudgetAvailableUsdMicros = Math.max(
    config.tracker.weeklyProviderBudgetCents * 10_000 -
      projectUsage.accountedUsdMicros -
      projectUsage.heldUsdMicros,
    0,
  );
  const weeklyProjectProviderBudgetAvailableUsd =
    weeklyProjectProviderBudgetAvailableUsdMicros / 1e6;
  const weeklyProviderBudgetAvailableUsdMicros = Math.min(
    weeklyProviderBudgetGlobalAvailableUsdMicros,
    weeklyProjectProviderBudgetAvailableUsdMicros,
  );
  const weeklyProviderBudgetAvailableUsd =
    weeklyProviderBudgetAvailableUsdMicros / 1e6;
  const liveEngines = scope.engines.filter(aiEngineUsesModelApi);
  const scheduleInterval =
    input.scheduleInterval ?? current?.tracker.scheduleInterval ?? "weekly";
  const checksPerMonth = scheduledChecksPerMonth(scheduleInterval);
  return {
    promptCount: scope.prompts.length,
    engineCount: scope.engines.length,
    observations: answers.length,
    ...cost,
    runNowProviderCostUsd: runNow.providerCostUsd,
    providerCostBounded: cost.providerCostBounded,
    runNowCostUsd: runNow.costUsd,
    runNowCostCredits: runNow.costCredits,
    scheduleInterval,
    checksPerMonth,
    monthlyCostUsd: Math.round(cost.costUsd * checksPerMonth * 1e6) / 1e6,
    weeklyProviderBudgetUsd,
    weeklyProviderBudgetAccountedUsd,
    weeklyProviderBudgetHeldUsd,
    weeklyProviderBudgetAvailableUsd,
    weeklyProviderBudgetGlobalAvailableUsd,
    weeklyProjectProviderBudgetUsd,
    weeklyProjectProviderBudgetAccountedUsd,
    weeklyProjectProviderBudgetHeldUsd,
    weeklyProjectProviderBudgetAvailableUsd,
    runNowProviderBudgetRemainingUsd:
      Math.max(
        weeklyProviderBudgetAvailableUsdMicros -
          Math.round(runNow.providerCostUsd * 1e6),
        0,
      ) / 1e6,
    weeklyProviderBudgetScope: "installation",
    weeklyProviderBudgetWindowDays: 7,
    currency: "USD",
    warnings: [
      hosted
        ? "Customer cost uses OpenSEO data credits, including the service markup."
        : "Self-hosted: cost estimates your own DataForSEO account charges. OpenSEO credits are not used.",
      `One fresh answer per prompt and engine. The ${scheduleInterval} estimate assumes ${checksPerMonth} ${checksPerMonth === 1 ? "check" : "checks"} per month.`,
      ...(liveEngines.length
        ? [
            `${liveEngines.map((e) => AI_ENGINE_LABELS[e]).join(" and ")} ${liveEngines.length === 1 ? "uses" : "use"} live API pricing, which costs more per answer.`,
          ]
        : []),
      ...(!cost.providerCostBounded
        ? [
            "This selection includes an LLM Responses route whose token and web-search charges have no enforceable per-run ceiling. The forecast is informational and paid runs are disabled for this selection.",
          ]
        : []),
      ...(!(await hasDataforseoAccess())
        ? [
            "DataForSEO is not configured on this server. Setup is available; collection needs an operator to add its API key.",
          ]
        : []),
    ],
  };
}

import type { BillingCustomerContext } from "@/server/billing/subscription";
import {
  createDataforseoClient,
  type PostedAiTrackingTask,
} from "@/server/lib/dataforseo";
import {
  DataforseoChargedTaskError,
  DataforseoDispatchNotStartedError,
} from "@/server/lib/dataforseo/envelope";
import { asAppError } from "@/server/lib/errors";
import type { ErrorCode } from "@/shared/error-codes";
import { AiVisibilityRepository as repo } from "../repositories/AiVisibilityRepository";
import type { AiPostedHold } from "./aiVisibilityBilling";
import type { AiProviderCostOutcome } from "./aiVisibilityLiveAnswerCosts";
import type {
  AiPendingTask,
  AiRunMarket,
  AiTaskBatch,
} from "./aiVisibilityCollection";

/** Posts one queued answer batch and reports whether dispatch is possible. */
export async function postAiBatch(
  runId: string,
  customer: BillingCustomerContext,
  market: AiRunMarket,
  batch: AiTaskBatch,
): Promise<
  {
    pending: AiPendingTask[];
    hold: AiPostedHold | null;
  } & AiProviderCostOutcome
> {
  let posted: PostedAiTrackingTask[] = [];
  let hold: AiPostedHold | null = null;
  let providerCostUsd = 0;
  let providerCostKnown = false;
  let providerCallMayHaveStarted = true;
  let error: ErrorCode = "INTERNAL_ERROR";
  try {
    const result = await createDataforseoClient(
      customer,
    ).aiSearch.trackingTaskPost({
      engine: batch.engine,
      tasks: batch.tasks,
      ...market,
    });
    posted = result.tasks;
    if (result.hold) hold = { ...result.hold, tasks: posted };
    providerCostUsd = result.providerCostUsd;
    providerCostKnown =
      result.providerCostKnown &&
      Number.isFinite(providerCostUsd) &&
      providerCostUsd >= 0;
  } catch (cause) {
    error = asAppError(cause)?.code ?? "INTERNAL_ERROR";
    if (cause instanceof DataforseoDispatchNotStartedError) {
      providerCallMayHaveStarted = false;
      providerCostKnown = true;
    } else if (cause instanceof DataforseoChargedTaskError) {
      providerCostUsd = cause.billing.costUsd;
      providerCostKnown =
        cause.billing.costKnown !== false &&
        Number.isFinite(providerCostUsd) &&
        providerCostUsd >= 0;
    }
    console.warn(
      `[ai-visibility] ${runId} task_post failed:`,
      cause instanceof DataforseoDispatchNotStartedError
        ? cause.originalError
        : cause,
    );
  }
  const postedByTag = new Map(posted.map((task) => [task.tag, task]));
  const rejected = batch.tasks
    .map((task) => task.tag)
    .filter((tag) => !postedByTag.has(tag));
  if (rejected.length)
    await repo.failPendingObservations(runId, error, rejected);
  const pending = batch.tasks.flatMap((task) => {
    const postedTask = postedByTag.get(task.tag);
    if (!postedTask) return [];
    const attempts = (task.attempts ?? 0) + 1;
    return [{ ...task, ...postedTask, engine: batch.engine, attempts }];
  });
  return {
    pending,
    hold,
    providerCostUsd,
    providerCostKnown,
    providerCallMayHaveStarted,
  };
}

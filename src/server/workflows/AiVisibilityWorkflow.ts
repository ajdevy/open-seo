import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { pgStep } from "./pgStep";
import { yieldingStep } from "./yieldingStep";
import {
  collectAiLiveBatch,
  collectAiModelBatch,
  collectAiRound,
  collectLateAiAnswers,
  postAiBatch,
  prepareAiRun,
  type AiPendingTask,
} from "@/server/features/ai-visibility/services/aiVisibilityCollection";
import {
  finalizeAiRun,
  markAiRunFailed,
} from "@/server/features/ai-visibility/services/aiVisibilityRunOutcome";
import {
  settleAiRun,
  type AiPostedHold,
} from "@/server/features/ai-visibility/services/aiVisibilityBilling";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import { AI_TRACKING_HOLD_TTL_MS } from "@/server/lib/dataforseo";
import { describeError } from "@/server/lib/errors";
import {
  hasReservedAiProviderRunBudget,
  markAiProviderRunBudgetUnknown,
  releaseAiProviderRunBudget,
  settleAiProviderRunBudget,
} from "@/server/features/ai-visibility/repositories/AiProviderRunBudgetRepository";

// One binding serves answer collection runs and the one-time research setup,
// so setup needs no new workflow infrastructure.
type AiVisibilityPayload = (
  | { runId: string }
  | { setupProjectId: string; runSeededTracking?: boolean }
) & {
  customer: BillingCustomerContext;
};

// Metered and paid steps run once: a retry could post (and bill) twice.
const SINGLE_ATTEMPT = {
  retries: { limit: 0, delay: "1 second" as const },
  timeout: "2 minutes" as const,
};
// Steps that only read and write our own rows are free and safe to repeat, so
// an engine failure on one attempt does not fail the run.
const FREE_STEP = {
  retries: { limit: 2, delay: "10 seconds" as const },
  timeout: "2 minutes" as const,
};
// task_get is free and saving an answer replaces its evidence, so collect
// steps can retry.
const COLLECT_STEP = {
  retries: { limit: 2, delay: "10 seconds" as const },
  timeout: "5 minutes" as const,
};
// Live answers are billed per call, so a live step runs once too. It waits for
// up to 6 answers, each up to 120 seconds, and asks a failed answer up to 3
// times.
const LIVE_STEP = { ...SINGLE_ATTEMPT, timeout: "10 minutes" as const };
// Standard-queue answers usually arrive within minutes. Cumulative waits are
// 2 / 4 / 7 / 10 / 14 / 18 / 22 / 26 / 30 minutes; anything still missing then
// fails as not collected, until a late read finds it. Each sleep stays under 5
// minutes, like rank check's: the engine cancels an invocation idling in a
// longer sleep.
const POLL_INTERVALS = [
  "2 minutes",
  "2 minutes",
  "3 minutes",
  "3 minutes",
  "4 minutes",
  "4 minutes",
  "4 minutes",
  "4 minutes",
  "4 minutes",
] as const;
// After the run finishes, answers DataForSEO has not returned yet are read
// every 30 minutes, so a provider delay fills the run in late without holding
// up the tracker. Reads stop an hour before the credit hold expires, which
// leaves time to settle it; the hold starts after the workflow does.
const LATE_READ_INTERVAL_MS = 30 * 60_000;
const LATE_READS_FOR_MS = AI_TRACKING_HOLD_TTL_MS - 60 * 60_000;

export class AiVisibilityWorkflow extends WorkflowEntrypoint<
  Env,
  AiVisibilityPayload
> {
  async run(
    event: WorkflowEvent<AiVisibilityPayload>,
    engineStep: WorkflowStep,
  ) {
    const step = yieldingStep(engineStep);
    const { payload } = event;
    if ("setupProjectId" in payload)
      // Setup can call OpenRouter and live search, but has no shared provider-
      // budget reservation/accounting path. Fail closed before dispatch.
      throw new NonRetryableError(
        "AI research setup is paused because it has no provider-budget reservation; no provider request was started.",
      );
    const { runId, customer } = payload;
    const assertProviderBudgetReservation = async (stepName: string) => {
      // This must be a distinct workflow step before the paid step. Its new
      // name forces persisted workflows from older deployments to execute the
      // reservation check even when their paid step result is already cached.
      const isReserved = await pgStep(
        step,
        `provider-budget-${stepName}`,
        FREE_STEP,
        () => hasReservedAiProviderRunBudget(runId),
      );
      if (!isReserved)
        throw new NonRetryableError(
          "The provider budget reservation is missing or unresolved; no provider request was started.",
        );
    };
    let pending: AiPendingTask[] = [];
    let providerCallMayHaveStarted = false;
    let providerCostUsd = 0;
    let providerCostKnown = true;
    // Each posted batch holds credits until settle charges the answers that
    // arrived, once late reads end or the run fails.
    const holds: AiPostedHold[] = [];
    // A run in flight across the deploy that added holds replays an older
    // post output, the bare task list, which was charged when posted.
    const queue = (posted: Awaited<ReturnType<typeof postAiBatch>>) => {
      if (Array.isArray(posted)) {
        // Workflow state persisted by an older deployment has no per-call
        // provider billing metadata, so retain its hold for reconciliation.
        providerCostKnown = false;
        return pending.push(...posted);
      }
      if (
        typeof posted.providerCostUsd === "number" &&
        Number.isFinite(posted.providerCostUsd) &&
        posted.providerCostUsd >= 0 &&
        posted.providerCostKnown
      )
        providerCostUsd += posted.providerCostUsd;
      else providerCostKnown = false;
      if (posted.hold) holds.push(posted.hold);
      pending.push(...posted.pending);
    };
    const settle = async () => {
      if (holds.length === 0) return;
      const posted = holds.splice(0);
      try {
        // Safe to retry: Autumn settles a hold once, then forgets its lock.
        await pgStep(step, "settle", FREE_STEP, () =>
          settleAiRun(runId, customer, posted),
        );
      } catch (error) {
        // A hold left open expires at its TTL without charging.
        console.error(
          `[ai-visibility] ${runId} settle failed: ${describeError(error)}`,
          error,
        );
      }
    };
    const markFailed = async (error: unknown) => {
      await settle();
      await pgStep(step, "mark-failed-with-provider-budget", FREE_STEP, () =>
        (async () => {
          // Release only when the workflow proves no provider dispatch began.
          // Otherwise preserve the full hold for evidence-based reconciliation.
          if (providerCallMayHaveStarted)
            await markAiProviderRunBudgetUnknown(runId);
          else await releaseAiProviderRunBudget(runId);
          await markAiRunFailed(runId);
        })(),
      );
      throw error;
    };
    const failRun = (error: unknown) => {
      console.error(
        `[ai-visibility] ${runId} failed: ${describeError(error)}`,
        error,
      );
      return markFailed(error);
    };
    let plan: Awaited<ReturnType<typeof prepareAiRun>>;
    // Reads the pending answers once, then posts each answer that DataForSEO's
    // backend failed again in its own step, since a post is billed. The read
    // steps are `read-*`, not the older `collect-*`: a run in flight across a
    // deploy must not replay a `collect-*` output, which had another shape.
    const collect = async (name: string, canRetry: boolean) => {
      const remaining = pending;
      let round: Awaited<ReturnType<typeof collectAiRound>>;
      try {
        round = await pgStep(step, `read-${name}`, COLLECT_STEP, () =>
          collectAiRound(runId, remaining, canRetry),
        );
      } catch (error) {
        // Posted tasks keep their credit hold; poll them again next round.
        console.warn(
          `[ai-visibility] ${runId} read-${name}: ${describeError(error)}`,
        );
        return;
      }
      pending = round.pending;
      for (const [index, batch] of round.retry.entries()) {
        try {
          await assertProviderBudgetReservation(`repost-${name}-${index}`);
          providerCallMayHaveStarted = true;
          queue(
            await pgStep(step, `repost-${name}-${index}`, SINGLE_ATTEMPT, () =>
              postAiBatch(runId, customer, plan.market, batch),
            ),
          );
        } catch (error) {
          // Its answers fail at finalize.
          // The request may have reached the provider before the step failed.
          providerCostKnown = false;
          console.warn(
            `[ai-visibility] ${runId} repost-${name}: ${describeError(error)}`,
          );
        }
      }
    };
    try {
      plan = await pgStep(step, "prepare", FREE_STEP, () =>
        prepareAiRun(runId),
      );
    } catch (error) {
      return failRun(error);
    }
    // A batch whose step fails, on the engine's own error or a timeout, leaves
    // its answers pending for finalize to fail. The other batches still run,
    // so the run keeps every answer it got.
    if (plan.live)
      // Live runs save each live batch as it returns, so nothing is left
      // pending to poll.
      for (const [index, tasks] of plan.batches.entries())
        try {
          await assertProviderBudgetReservation(`live-${index}`);
          providerCallMayHaveStarted = true;
          const outcome = await pgStep(step, `live-${index}`, LIVE_STEP, () =>
            collectAiLiveBatch(runId, customer, plan.market, tasks),
          );
          if (
            outcome?.providerCostKnown &&
            Number.isFinite(outcome.providerCostUsd) &&
            outcome.providerCostUsd >= 0
          )
            providerCostUsd += outcome.providerCostUsd;
          else providerCostKnown = false;
        } catch (error) {
          providerCostKnown = false;
          console.warn(
            `[ai-visibility] ${runId} live-${index}: ${describeError(error)}`,
          );
        }
    else
      for (const [index, batch] of plan.batches.entries())
        try {
          await assertProviderBudgetReservation(`post-${index}`);
          providerCallMayHaveStarted = true;
          queue(
            await pgStep(step, `post-${index}`, SINGLE_ATTEMPT, () =>
              postAiBatch(runId, customer, plan.market, batch),
            ),
          );
        } catch (error) {
          // The request may have reached the provider before the step failed.
          providerCostKnown = false;
          console.warn(
            `[ai-visibility] ${runId} post-${index}: ${describeError(error)}`,
          );
        }
    // Legacy workflow instances may still replay model API steps; their
    // provider cost is unknown, so they remain held for reconciliation.
    for (const [index, batch] of plan.modelBatches.entries()) {
      // This path never supplies a provider price, even when the new guard
      // rejects the old step before reaching the provider.
      providerCostKnown = false;
      try {
        await assertProviderBudgetReservation(`model-${index}`);
        providerCallMayHaveStarted = true;
        // New model API dispatches are blocked before this step. An older
        // persisted workflow plan can still replay it, so never settle its
        // budget from an estimate or a missing legacy step result.
        await pgStep(step, `model-${index}`, LIVE_STEP, () =>
          collectAiModelBatch(runId, customer, plan.market, batch),
        );
      } catch (error) {
        // Its unsaved answers fail at finalize; the other batches continue.
        console.warn(
          `[ai-visibility] ${runId} model-${index}: ${describeError(error)}`,
        );
      }
      if (pending.length) await collect(`model-${index}`, true);
    }
    for (
      let round = 0;
      round < POLL_INTERVALS.length && pending.length > 0;
      round++
    ) {
      try {
        await step.sleep(`wait-${round}`, POLL_INTERVALS[round]);
      } catch (error) {
        // The engine cancels an invocation idling in a long sleep, which
        // rejects it here, then resumes the instance on wake. That interrupt
        // never runs mark-failed, so only a real failure fails the run. Don't
        // log it as one.
        return markFailed(error);
      }
      // A task posted after the last round would never be read.
      await collect(`${round}`, round < POLL_INTERVALS.length - 1);
    }
    let finishedAt: number;
    try {
      finishedAt = await pgStep(step, "finalize", FREE_STEP, async () => {
        await finalizeAiRun(runId);
        return Date.now();
      });
    } catch (error) {
      return failRun(error);
    }
    const lateUntil = event.timestamp.getTime() + LATE_READS_FOR_MS;
    for (let round = 1; pending.length > 0; round++) {
      const wakeAt = finishedAt + round * LATE_READ_INTERVAL_MS;
      if (wakeAt > lateUntil) break;
      // Uncaught: the engine cancels an invocation idling this long and
      // resumes the instance on wake, so the rejection is no failure, and
      // settling here would charge before late answers arrive.
      await step.sleepUntil(`late-wait-${round}`, wakeAt);
      try {
        pending = await pgStep(step, `late-${round}`, COLLECT_STEP, () =>
          collectLateAiAnswers(runId, pending),
        );
      } catch (error) {
        // Read again next round.
        console.warn(
          `[ai-visibility] ${runId} late-${round}: ${describeError(error)}`,
        );
      }
    }
    await settle();
    await pgStep(step, "settle-provider-budget", FREE_STEP, async () => {
      const accountedUsdMicros = Math.round(providerCostUsd * 1e6);
      if (
        providerCostKnown &&
        Number.isSafeInteger(accountedUsdMicros) &&
        accountedUsdMicros >= 0
      )
        await settleAiProviderRunBudget(
          runId,
          accountedUsdMicros,
          new Date().toISOString(),
        );
      else await markAiProviderRunBudgetUnknown(runId);
    });
  }
}

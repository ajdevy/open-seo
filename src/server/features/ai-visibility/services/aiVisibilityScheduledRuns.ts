import { env } from "cloudflare:workers";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import { describeError } from "@/server/lib/errors";
import { AiVisibilityRepository as repo } from "../repositories/AiVisibilityRepository";
import { AiVisibilityScheduledRunRepository as scheduledRepo } from "../repositories/AiVisibilityScheduledRunRepository";
import { AI_ANSWER_FAILURES, AiVisibilityError } from "./aiVisibilityErrors";
import {
  failAiRun,
  reconcileAiRun,
  prepareRun,
  rowsForRun,
  startWorkflowForRun,
} from "./aiVisibilityRuns";
import { reserveProviderBudgetForRun } from "./aiVisibilityProviderBudget";
import { releaseAiProviderRunBudget } from "../repositories/AiProviderRunBudgetRepository";
import type { ConfigurationRows } from "../repositories/AiVisibilityRepository";
import {
  handleUnauthorizedScheduledRun,
  pauseTrackingIfProviderUnavailable,
  scheduledRunAuthorizationError,
} from "./scheduledAiVisibilityAuthorization";

const ACTIVE_WORKFLOW_STATUSES = new Set([
  "queued",
  "running",
  "waiting",
  "waitingForPause",
  "paused",
]);
const SCHEDULED_RETRY_NOTICE =
  "The scheduled check is durably queued and will be retried automatically.";
const SCHEDULED_RESERVATION_UNRESOLVED_NOTICE =
  "The scheduled check's provider-budget reservation could not be confirmed. No workflow was started, and the run must be reconciled before retry.";

function withoutScheduledRetryNotice(reason: string | null | undefined) {
  if (reason === SCHEDULED_RETRY_NOTICE) return null;
  const base = reason?.split(`\n${SCHEDULED_RETRY_NOTICE}`)[0] ?? "";
  return base || null;
}

function withScheduledRetryNotice(reason: string | null | undefined) {
  const base = withoutScheduledRetryNotice(reason);
  return [base, SCHEDULED_RETRY_NOTICE].filter(Boolean).join("\n");
}

/**
 * Starts a persisted outbox item. Reusing its run id makes retries idempotent;
 * a failed start leaves the pointer for the next cron tick.
 */
export async function resumePendingScheduledRuns(input: {
  answerBudget: number;
  deadline: number;
}) {
  let started = 0;
  let answersStarted = 0;
  for (const pending of await scheduledRepo.listPendingScheduledRuns()) {
    if (Date.now() >= input.deadline) break;
    const runId = pending.pendingScheduledRunId;
    if (!runId) continue;
    try {
      const run = pending.run ?? (await repo.getRunInternal(runId));
      if (!run) {
        await scheduledRepo.clearPendingScheduledRun({
          trackerId: pending.trackerId,
          runId,
          lastSkipReason: [
            withoutScheduledRetryNotice(pending.lastSkipReason),
            "A scheduled check claim had no run record and was skipped during reconciliation.",
          ]
            .filter(Boolean)
            .join(" "),
        });
        continue;
      }
      if (run.status !== "queued" && run.status !== "running") {
        await scheduledRepo.clearPendingScheduledRun({
          trackerId: pending.trackerId,
          runId,
          lastSkipReason: withoutScheduledRetryNotice(pending.lastSkipReason),
        });
        continue;
      }

      const instanceStatus = await env.AI_VISIBILITY_WORKFLOW.get(run.id)
        .then((instance) => instance.status())
        .catch(() => null);
      const authorizationError = await scheduledRunAuthorizationError(run);
      if (
        instanceStatus &&
        ACTIVE_WORKFLOW_STATUSES.has(instanceStatus.status)
      ) {
        await pauseTrackingIfProviderUnavailable(
          pending.trackerId,
          authorizationError ?? "",
          true,
        );
        await scheduledRepo.clearPendingScheduledRun({
          trackerId: pending.trackerId,
          runId,
          lastSkipReason:
            authorizationError ??
            withoutScheduledRetryNotice(pending.lastSkipReason),
        });
        continue;
      }
      if (authorizationError) {
        await handleUnauthorizedScheduledRun({
          trackerId: pending.trackerId,
          run,
          reason: authorizationError,
        });
        continue;
      }
      if (
        instanceStatus &&
        !ACTIVE_WORKFLOW_STATUSES.has(instanceStatus.status)
      ) {
        const reconciled = await reconcileAiRun(run);
        if (reconciled.status !== "queued" && reconciled.status !== "running") {
          await scheduledRepo.clearPendingScheduledRun({
            trackerId: pending.trackerId,
            runId,
            lastSkipReason: withoutScheduledRetryNotice(pending.lastSkipReason),
          });
          continue;
        }
        // A just-created terminal instance may still be finishing its database
        // writes. Leave its outbox pointer until the next tick resolves it.
        continue;
      }

      const observations = await repo.getObservations([run.id]);
      if (!observations.length) {
        await failAiRun(run.id, AI_ANSWER_FAILURES.notStarted);
        await scheduledRepo.clearPendingScheduledRun({
          trackerId: pending.trackerId,
          runId,
          lastSkipReason:
            "A scheduled check had no saved answer rows and was skipped during reconciliation.",
        });
        continue;
      }
      if (
        started > 0 &&
        answersStarted + observations.length > input.answerBudget
      )
        break;

      let reservation: Awaited<ReturnType<typeof reserveProviderBudgetForRun>>;
      try {
        reservation = await reserveProviderBudgetForRun({
          run,
          limitUsdCents: pending.weeklyProviderBudgetCents,
          engines: observations.map((observation) => observation.engine),
        });
      } catch (error) {
        await failAiRun(run.id, AI_ANSWER_FAILURES.notStarted).catch(
          () => undefined,
        );
        await scheduledRepo.setPendingScheduledRunNotice({
          trackerId: pending.trackerId,
          runId,
          lastSkipReason: [
            withoutScheduledRetryNotice(pending.lastSkipReason),
            SCHEDULED_RESERVATION_UNRESOLVED_NOTICE,
          ]
            .filter(Boolean)
            .join(" "),
        });
        console.error("[ai-visibility] scheduled budget reservation deferred", {
          trackerId: pending.trackerId,
          runId,
          error: describeError(error),
        });
        continue;
      }
      if (!reservation.admission.admitted) {
        const message = reservation.message;
        if (!message)
          throw new Error("Provider budget refusal had no message.");
        if (reservation.admission.reason === "cost_ceiling_unavailable")
          await releaseAiProviderRunBudget(run.id);
        await failAiRun(run.id, AI_ANSWER_FAILURES.notStarted);
        await scheduledRepo.clearPendingScheduledRun({
          trackerId: pending.trackerId,
          runId,
          lastSkipReason: message,
        });
        continue;
      }

      try {
        await startWorkflowForRun(run.id, run.projectId, {
          organizationId: pending.organizationId,
          userId: "system",
          userEmail: "system@openseo.so",
          projectId: run.projectId,
        });
        await scheduledRepo.clearPendingScheduledRun({
          trackerId: pending.trackerId,
          runId,
          lastSkipReason: withoutScheduledRetryNotice(pending.lastSkipReason),
        });
      } catch (error) {
        await scheduledRepo.setPendingScheduledRunNotice({
          trackerId: pending.trackerId,
          runId,
          lastSkipReason: withScheduledRetryNotice(pending.lastSkipReason),
        });
        console.error("[ai-visibility] scheduled outbox resume deferred", {
          trackerId: pending.trackerId,
          runId,
          error: describeError(error),
        });
      } finally {
        // A lost workflow-start response may still have created the instance.
        // Count it against this tick so retries cannot bypass the answer budget.
        started++;
        answersStarted += observations.length;
      }
    } catch (error) {
      console.error("[ai-visibility] scheduled outbox recovery failed", {
        trackerId: pending.trackerId,
        runId,
        error: describeError(error),
      });
    }
  }
  return { started, answersStarted };
}

/**
 * Persists the due occurrence and its queued run atomically before asking the
 * workflow engine to start. A later tick resumes the same run id if startup
 * fails or this process stops after the database commit.
 */
export async function startScheduledRun(input: {
  config: ConfigurationRows;
  billing: BillingCustomerContext;
  trackerId: string;
  observedNextCheckAt: string;
  nextCheckAt: string;
  lastSkipReason: string | null;
}): Promise<"not-claimed" | "started" | "deferred" | "skipped"> {
  const prepared = await prepareRun(input.config, "scheduled", input.billing);
  const id = crypto.randomUUID();
  const rows = rowsForRun(prepared, id);
  let claimed: Awaited<ReturnType<typeof scheduledRepo.claimScheduledRun>>;
  try {
    claimed = await scheduledRepo.claimScheduledRun({
      trackerId: input.trackerId,
      observedNextCheckAt: input.observedNextCheckAt,
      nextCheckAt: input.nextCheckAt,
      lastSkipReason: input.lastSkipReason,
      run: rows.run,
      observations: rows.observations,
    });
  } catch (error) {
    const blocker = await repo.getActiveRun(input.trackerId);
    if (blocker)
      throw new AiVisibilityError(
        "RUN_IN_PROGRESS",
        "A check is already collecting answers. The scheduled occurrence was not started.",
        blocker.id,
      );
    throw error;
  }
  if (!claimed) return "not-claimed";

  const authorizationError = await scheduledRunAuthorizationError(claimed);
  if (authorizationError) {
    const pausedForProvider = await pauseTrackingIfProviderUnavailable(
      input.trackerId,
      authorizationError,
    );
    if (!pausedForProvider)
      await scheduledRepo.cancelQueuedScheduledRun({
        trackerId: input.trackerId,
        runId: id,
        reason: authorizationError,
      });
    return pausedForProvider ? "deferred" : "skipped";
  }

  let reservation: Awaited<ReturnType<typeof reserveProviderBudgetForRun>>;
  try {
    reservation = await reserveProviderBudgetForRun({
      run: claimed,
      limitUsdCents: input.config.tracker.weeklyProviderBudgetCents,
      engines: rows.observations.map((observation) => observation.engine),
    });
  } catch (error) {
    await failAiRun(id, AI_ANSWER_FAILURES.notStarted).catch(() => undefined);
    await scheduledRepo.setPendingScheduledRunNotice({
      trackerId: input.trackerId,
      runId: id,
      lastSkipReason: [
        withoutScheduledRetryNotice(input.lastSkipReason),
        SCHEDULED_RESERVATION_UNRESOLVED_NOTICE,
      ]
        .filter(Boolean)
        .join(" "),
    });
    console.error("[ai-visibility] scheduled budget reservation deferred", {
      trackerId: input.trackerId,
      runId: id,
      error: describeError(error),
    });
    return "deferred";
  }
  if (!reservation.admission.admitted) {
    const message = reservation.message;
    if (!message) throw new Error("Provider budget refusal had no message.");
    await failAiRun(id, AI_ANSWER_FAILURES.notStarted);
    await scheduledRepo.clearPendingScheduledRun({
      trackerId: input.trackerId,
      runId: id,
      lastSkipReason: message,
    });
    return "skipped";
  }

  try {
    await startWorkflowForRun(id, prepared.project.id, input.billing);
    await scheduledRepo.clearPendingScheduledRun({
      trackerId: input.trackerId,
      runId: id,
    });
    return "started";
  } catch (error) {
    await scheduledRepo.setPendingScheduledRunNotice({
      trackerId: input.trackerId,
      runId: id,
      lastSkipReason: withScheduledRetryNotice(input.lastSkipReason),
    });
    console.error("[ai-visibility] scheduled outbox start deferred", {
      trackerId: input.trackerId,
      runId: id,
      error: describeError(error),
    });
    return "deferred";
  }
}

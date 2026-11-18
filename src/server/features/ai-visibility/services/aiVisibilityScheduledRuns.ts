import { env } from "cloudflare:workers";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import { describeError } from "@/server/lib/errors";
import { AiVisibilityRepository as repo } from "../repositories/AiVisibilityRepository";
import { AiVisibilityScheduledRunRepository as scheduledRepo } from "../repositories/AiVisibilityScheduledRunRepository";
import { AiVisibilityError } from "./aiVisibilityErrors";
import {
  reconcileAiRun,
  prepareRun,
  rowsForRun,
  startWorkflowForRun,
} from "./aiVisibilityRuns";
import type { ConfigurationRows } from "../repositories/AiVisibilityRepository";

const ACTIVE_WORKFLOW_STATUSES = new Set([
  "queued",
  "running",
  "waiting",
  "waitingForPause",
  "paused",
]);
const SCHEDULED_RETRY_NOTICE =
  "The scheduled check is durably queued and will be retried automatically.";

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
export async function resumePendingScheduledRuns() {
  let resumed = 0;
  for (const pending of await scheduledRepo.listPendingScheduledRuns()) {
    const runId = pending.pendingScheduledRunId;
    if (!runId) continue;
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
      resumed++;
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
    }
  }
  return resumed;
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
}): Promise<"not-claimed" | "started" | "deferred"> {
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

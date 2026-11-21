import { AiVisibilityRepository as repo } from "../repositories/AiVisibilityRepository";
import { AiVisibilityScheduledRunRepository as scheduledRepo } from "../repositories/AiVisibilityScheduledRunRepository";
import { reconcileAiRun } from "./aiVisibilityRuns";
import { hasDataforseoAccess } from "@/server/lib/provider-access";
import { scheduledRunScopeError } from "./aiVisibilityScheduledRunScope";
import type { RunRow } from "../repositories/AiVisibilityRepository";

const SCHEDULED_PROVIDER_UNAVAILABLE_REASON =
  "The configured provider is unavailable; the queued check was not started.";

export async function scheduledRunAuthorizationError(run: RunRow) {
  const config = await repo.getConfiguration(run.projectId);
  if (!config || !config.tracker.enabled) {
    if (
      config?.tracker.lastSkipReason === SCHEDULED_PROVIDER_UNAVAILABLE_REASON
    )
      return SCHEDULED_PROVIDER_UNAVAILABLE_REASON;
    return "Scheduled tracking was paused before the queued check started.";
  }
  const scopeError = await scheduledRunScopeError(run, "queue", config);
  if (scopeError) return scopeError;
  if (!(await hasDataforseoAccess()))
    return SCHEDULED_PROVIDER_UNAVAILABLE_REASON;
  return null;
}

export async function pauseTrackingIfProviderUnavailable(
  trackerId: string,
  reason: string,
  preservePendingRun = false,
) {
  if (reason !== SCHEDULED_PROVIDER_UNAVAILABLE_REASON) return false;
  await repo.updateTracker(
    trackerId,
    { enabled: false, lastSkipReason: reason },
    { cancelQueuedRuns: !preservePendingRun },
  );
  return true;
}

export async function handleUnauthorizedScheduledRun(input: {
  trackerId: string;
  run: RunRow;
  reason: string;
}) {
  const pausedForProvider = await pauseTrackingIfProviderUnavailable(
    input.trackerId,
    input.reason,
  );
  if (input.run.status === "queued") {
    if (!pausedForProvider)
      await scheduledRepo.cancelQueuedScheduledRun({
        trackerId: input.trackerId,
        runId: input.run.id,
        reason: input.reason,
      });
    return;
  }

  const reconciled = await reconcileAiRun(input.run);
  if (reconciled.status !== "queued" && reconciled.status !== "running") {
    await scheduledRepo.clearPendingScheduledRun({
      trackerId: input.trackerId,
      runId: input.run.id,
      lastSkipReason: input.reason,
    });
    return;
  }
  await scheduledRepo.setPendingScheduledRunNotice({
    trackerId: input.trackerId,
    runId: input.run.id,
    lastSkipReason: input.reason,
  });
}

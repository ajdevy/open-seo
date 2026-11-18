import { AiVisibilityRepository as repo } from "../repositories/AiVisibilityRepository";
import { AiVisibilityScheduledRunRepository as scheduledRepo } from "../repositories/AiVisibilityScheduledRunRepository";
import { reconcileAiRun } from "./aiVisibilityRuns";
import { activeAiPrompts, trackerEngines } from "./aiVisibilityConfiguration";
import { hasDataforseoAccess } from "@/server/lib/provider-access";
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

  const prompts = activeAiPrompts(config);
  const engines = trackerEngines(config.tracker);
  if (!prompts.length || !engines.length)
    return "The saved tracking scope no longer has active prompts and models.";
  if (
    config.tracker.locationCode !== run.locationCode ||
    config.tracker.languageCode !== run.languageCode
  )
    return "The saved market changed before the queued check started.";

  const expected = new Set(
    prompts.flatMap((prompt) =>
      engines.map((engine) => `${prompt.id}:${engine}`),
    ),
  );
  const observations = await repo.getObservations([run.id]);
  const actual = new Set(
    observations.map(
      (observation) => `${observation.promptId}:${observation.engine}`,
    ),
  );
  if (
    actual.size !== expected.size ||
    [...expected].some((observation) => !actual.has(observation))
  )
    return "The saved prompt or model scope changed before the queued check started.";
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

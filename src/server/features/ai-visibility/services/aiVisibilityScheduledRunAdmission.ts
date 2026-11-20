import { AiVisibilityRepository as repo } from "../repositories/AiVisibilityRepository";
import { AiVisibilityScheduledRunRepository as scheduledRepo } from "../repositories/AiVisibilityScheduledRunRepository";
import type { RunRow } from "../repositories/AiVisibilityRepository";

const SCHEDULED_RUN_ADMISSION_CANCEL_REASON =
  "The scheduled check was canceled because its project was archived or it was no longer queued before provider dispatch.";

export async function cancelArchivedQueuedScheduledRun(
  run: RunRow,
  runId: string,
  reason: string,
) {
  if (run.status !== "queued" || (await repo.isProjectActive(run.projectId)))
    return;
  await scheduledRepo.cancelQueuedScheduledRun({
    trackerId: run.trackerId,
    runId,
    reason,
  });
}

export async function admitQueuedScheduledRun(run: RunRow, runId: string) {
  if (await repo.startScheduledRunIfQueued(runId)) return true;
  await scheduledRepo.cancelQueuedScheduledRun({
    trackerId: run.trackerId,
    runId,
    reason: SCHEDULED_RUN_ADMISSION_CANCEL_REASON,
  });
  return false;
}

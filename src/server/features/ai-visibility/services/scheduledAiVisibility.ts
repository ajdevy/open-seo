import { AppError, describeError } from "@/server/lib/errors";
import { pruneAiVisibility } from "./aiVisibilityRetention";
import { AiVisibilityRepository as repo } from "../repositories/AiVisibilityRepository";
import { AiVisibilityError } from "./aiVisibilityErrors";
import { activeAiPrompts, trackerEngines } from "./aiVisibilityConfiguration";
import { startRun } from "./aiVisibilityRuns";
import { computeNextCheckAt } from "@/shared/rank-tracking";
import {
  computeNextAiWallClockCheckAtSkippingUnresolved,
  ScheduleTimeResolutionError,
} from "@/shared/ai-visibility-schedule";

// Answers admitted per tick. Like rank tracking's task-unit budget, it keeps
// task_get polling under DataForSEO's 2,000 requests a minute; the first start
// of a tick is always admitted so a large tracker never starves. Trackers past
// the budget stay due for the next tick, oldest first.
const SCHEDULED_ANSWER_BUDGET = 1000;
const TICK_DEADLINE_MS = 2 * 60_000;

/** Cron body: start a check for every due tracker. */
export async function runScheduledAiVisibility() {
  try {
    await pruneAiVisibility();
  } catch (error) {
    console.error("[ai-visibility] retention sweep failed", error);
  }
  const deadline = Date.now() + TICK_DEADLINE_MS;
  let started = 0;
  let answersStarted = 0;
  for (const { tracker, organizationId } of await repo.listDue(
    new Date().toISOString(),
  )) {
    if (Date.now() >= deadline) break;
    // Unreachable: the due query only returns trackers with a next check.
    if (!tracker.nextCheckAt) continue;
    const observedNextCheckAt = tracker.nextCheckAt;
    let nextCheckAt: string;
    let scheduleSkipReason: string | null = null;
    try {
      const wallClockFields = [
        tracker.scheduleWeekday,
        tracker.scheduleHour,
        tracker.scheduleMinute,
        tracker.scheduleTimeZone,
      ];
      const hasWallClockSchedule = wallClockFields.some(
        (value) => value !== null,
      );
      const hasCompleteWallClockSchedule = wallClockFields.every(
        (value) => value !== null,
      );
      const explicitWallClock =
        tracker.scheduleWeekday !== null &&
        tracker.scheduleHour !== null &&
        tracker.scheduleMinute !== null &&
        tracker.scheduleTimeZone !== null
          ? {
              weekday: tracker.scheduleWeekday,
              hour: tracker.scheduleHour,
              minute: tracker.scheduleMinute,
              timeZone: tracker.scheduleTimeZone,
            }
          : null;
      if (
        tracker.scheduleInterval === "weekly" &&
        hasWallClockSchedule &&
        !hasCompleteWallClockSchedule
      )
        throw new ScheduleTimeResolutionError(
          "The saved weekly schedule is incomplete. Re-save the schedule to resume tracking.",
        );

      if (tracker.scheduleInterval === "weekly" && explicitWallClock) {
        const result = computeNextAiWallClockCheckAtSkippingUnresolved(
          explicitWallClock,
          observedNextCheckAt,
        );
        nextCheckAt = result.nextCheckAt;
        if (result.skippedLocalDates.length)
          scheduleSkipReason = `Skipped unresolved weekly local-time occurrence(s): ${result.skippedLocalDates.join(", ")}.`;
      } else {
        nextCheckAt = computeNextCheckAt(
          tracker.scheduleInterval,
          observedNextCheckAt,
        );
      }
    } catch (error) {
      const reason =
        error instanceof ScheduleTimeResolutionError
          ? error.message
          : "The saved weekly schedule could not be resolved. Re-save it to resume tracking.";
      await repo.claimDueTracker({
        trackerId: tracker.id,
        observedNextCheckAt,
        values: { enabled: false, lastSkipReason: reason },
      });
      console.error("[ai-visibility] invalid saved schedule paused", {
        trackerId: tracker.id,
        error: describeError(error),
      });
      continue;
    }
    try {
      const config = await repo.getConfiguration(tracker.projectId);
      if (!config) {
        await repo.claimDueTracker({
          trackerId: tracker.id,
          observedNextCheckAt,
          values: {
            enabled: false,
            lastSkipReason:
              "The tracking configuration is unavailable. Re-save it to resume tracking.",
          },
        });
        continue;
      }
      const answers =
        activeAiPrompts(config).length * trackerEngines(tracker).length;
      if (started > 0 && answersStarted + answers > SCHEDULED_ANSWER_BUDGET)
        break;
      // Advance the schedule before starting, so a tracker that fails or is
      // busy moves on instead of staying due and crowding out the rest.
      const claimed = await repo.claimDueTracker({
        trackerId: tracker.id,
        observedNextCheckAt,
        values: {
          nextCheckAt,
          lastSkipReason: scheduleSkipReason,
        },
      });
      if (!claimed) continue;
      // Always queued: a baseline collects live only when a user starts it
      // (onboarding or turning on the schedule) and waits for the answers.
      await startRun(config, "scheduled", {
        organizationId,
        userId: "system",
        userEmail: "system@openseo.so",
        projectId: tracker.projectId,
      });
      started++;
      answersStarted += answers;
    } catch (error) {
      // startRun records a credits skip on the tracker.
      if (error instanceof AppError && error.code === "INSUFFICIENT_CREDITS") {
        if (scheduleSkipReason)
          await repo
            .updateTracker(tracker.id, {
              lastSkipReason: `INSUFFICIENT_CREDITS; ${scheduleSkipReason}`,
            })
            .catch(() => undefined);
        continue;
      }
      if (!(error instanceof AiVisibilityError))
        console.error("[ai-visibility] scheduled check failed to start", {
          trackerId: tracker.id,
          error: describeError(error),
        });
      await repo
        .updateTracker(tracker.id, {
          lastSkipReason:
            error instanceof AiVisibilityError
              ? error.message
              : "The scheduled check could not start.",
        })
        .catch(() => undefined);
    }
  }
}

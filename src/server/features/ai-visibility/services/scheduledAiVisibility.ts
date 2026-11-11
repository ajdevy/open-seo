import { AppError, describeError } from "@/server/lib/errors";
import { pruneAiVisibility } from "./aiVisibilityRetention";
import { AiVisibilityRepository as repo } from "../repositories/AiVisibilityRepository";
import { AiVisibilityError } from "./aiVisibilityErrors";
import { activeAiPrompts, trackerEngines } from "./aiVisibilityConfiguration";
import { startRun } from "./aiVisibilityRuns";
import { computeNextCheckAt } from "@/shared/rank-tracking";
import {
  computeNextAiWallClockCheckAtSkippingUnresolved,
  listMissedAiWeeklyWallClockSlots,
  ScheduleTimeResolutionError,
  type AiWeeklyWallClockSchedule,
} from "@/shared/ai-visibility-schedule";

// Answers admitted per tick. Like rank tracking's task-unit budget, it keeps
// task_get polling under DataForSEO's 2,000 requests a minute; the first start
// of a tick is always admitted so a large tracker never starves. Trackers past
// the budget stay due for the next tick, oldest first.
const SCHEDULED_ANSWER_BUDGET = 1000;
const TICK_DEADLINE_MS = 2 * 60_000;
// The scheduler runs every five minutes, and the product promises a check
// within about fifteen minutes of the selected wall-clock time. Beyond that
// window a weekly occurrence is missed and must not be caught up automatically.
const WEEKLY_CHECK_START_GRACE_MS = 15 * 60_000;

function missedWeeklyWallClockNotice(
  schedule: AiWeeklyWallClockSchedule,
  observedNextCheckAt: string,
) {
  const slots = listMissedAiWeeklyWallClockSlots(schedule, observedNextCheckAt);
  const time = `${String(schedule.hour).padStart(2, "0")}:${String(schedule.minute).padStart(2, "0")}`;
  const slotDescriptions = slots.map(({ localDate, resolution }) => {
    const description = `${localDate} at ${time} ${schedule.timeZone}`;
    if (resolution === "nonexistent")
      return `${description} (the local time did not exist because of the daylight-saving gap)`;
    if (resolution === "ambiguous")
      return `${description} (the local time occurred twice because of the daylight-saving fold)`;
    return description;
  });

  return `Skipped missed weekly check slot(s): ${slotDescriptions.join("; ")}. No automatic catch-up check was started.`;
}

function missedWeeklyUtcNotice(observedNextCheckAt: string) {
  const dueAt = new Date(observedNextCheckAt).getTime();
  const now = Date.now();
  const weekMs = 7 * 24 * 60 * 60_000;
  const slots: string[] = [];
  for (let occurrence = dueAt; occurrence <= now; occurrence += weekMs)
    slots.push(new Date(occurrence).toISOString());

  return `Skipped missed weekly UTC check slot(s): ${slots.join("; ")}. No automatic catch-up check was started.`;
}

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
    let explicitWallClock: AiWeeklyWallClockSchedule | null = null;
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
      explicitWallClock =
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
    if (
      tracker.scheduleInterval === "weekly" &&
      Date.now() - new Date(observedNextCheckAt).getTime() >
        WEEKLY_CHECK_START_GRACE_MS
    ) {
      const lastSkipReason = explicitWallClock
        ? missedWeeklyWallClockNotice(explicitWallClock, observedNextCheckAt)
        : missedWeeklyUtcNotice(observedNextCheckAt);
      try {
        await repo.claimDueTracker({
          trackerId: tracker.id,
          observedNextCheckAt,
          values: { nextCheckAt, lastSkipReason },
        });
      } catch (error) {
        console.error("[ai-visibility] missed weekly slot could not advance", {
          trackerId: tracker.id,
          error: describeError(error),
        });
      }
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

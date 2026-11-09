import { AppError } from "@/server/lib/errors";
import { AiVisibilityRepository as repo } from "../repositories/AiVisibilityRepository";
import { AiVisibilityError } from "./aiVisibilityErrors";
import { activeAiPrompts } from "./aiVisibilityConfiguration";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import type { AiRun } from "@/shared/ai-visibility";
import type { SetAiScheduleInput } from "@/types/schemas/ai-visibility";
import { computeNextCheckAt } from "@/shared/rank-tracking";
import {
  computeNextAiWallClockCheckAt,
  ScheduleTimeResolutionError,
} from "@/shared/ai-visibility-schedule";
import { requireConfiguration } from "./aiVisibilityMutation";
import { getTracker } from "./aiVisibilityState";
import { startRun } from "./aiVisibilityRuns";
import { hasDataforseoAccess } from "@/server/lib/provider-access";

/**
 * Enables, reschedules or pauses tracking. The first enable also collects a
 * baseline now; an overdue next check is picked up by the scheduler.
 */
export async function setSchedule(
  input: SetAiScheduleInput,
  billing: BillingCustomerContext,
): Promise<{
  state: Awaited<ReturnType<typeof getTracker>>;
  run: AiRun | null;
}> {
  const config = await requireConfiguration(input.projectId);
  const { tracker } = config;
  if (!input.enabled) {
    await repo.updateTracker(tracker.id, { enabled: false });
    return { state: await getTracker(input), run: null };
  }
  const scheduleInterval = input.scheduleInterval ?? tracker.scheduleInterval;
  if (
    scheduleInterval === "weekly" &&
    input.scheduleTime?.timeZone !== undefined &&
    input.scheduleTime.weekday === undefined
  )
    throw new AiVisibilityError(
      "INVALID_SCHEDULE_TIME",
      "A weekday is required for a weekly schedule with a timezone.",
    );
  if (!activeAiPrompts(config).length)
    throw new AiVisibilityError(
      "NO_ACTIVE_PROMPTS",
      "Add active prompts before enabling scheduled tracking.",
    );
  if (!(await hasDataforseoAccess()))
    throw new AiVisibilityError(
      "PROVIDER_NOT_CONFIGURED",
      "Configure DataForSEO before enabling collection. Setup remains available.",
    );
  const explicitWallClock =
    scheduleInterval === "weekly" &&
    input.scheduleTime?.timeZone &&
    input.scheduleTime.weekday !== undefined
      ? {
          weekday: input.scheduleTime.weekday,
          hour: input.scheduleTime.hour,
          minute: input.scheduleTime.minute,
          timeZone: input.scheduleTime.timeZone,
        }
      : null;
  // The stored next check is the chosen slot. An unchanged schedule keeps it.
  let nextCheckAt = tracker.nextCheckAt;
  if (
    input.scheduleTime ||
    scheduleInterval !== tracker.scheduleInterval ||
    !tracker.nextCheckAt
  ) {
    try {
      nextCheckAt = explicitWallClock
        ? computeNextAiWallClockCheckAt(explicitWallClock)
        : computeNextCheckAt(scheduleInterval, null, input.scheduleTime);
    } catch (error) {
      if (error instanceof ScheduleTimeResolutionError)
        throw new AiVisibilityError("INVALID_SCHEDULE_TIME", error.message);
      throw error;
    }
  }
  const scheduleSettingsChanged =
    input.scheduleTime !== undefined ||
    scheduleInterval !== tracker.scheduleInterval;
  await repo.updateTracker(tracker.id, {
    enabled: true,
    scheduleInterval,
    ...(scheduleSettingsChanged
      ? {
          scheduleWeekday: explicitWallClock?.weekday ?? null,
          scheduleHour: explicitWallClock?.hour ?? null,
          scheduleMinute: explicitWallClock?.minute ?? null,
          scheduleTimeZone: explicitWallClock?.timeZone ?? null,
        }
      : {}),
    nextCheckAt,
    lastSkipReason: null,
  });
  let run: AiRun | null = null;
  if (!(await repo.getLatestScheduledRun(input.projectId))) {
    try {
      run = await startRun(config, "baseline", billing);
    } catch (error) {
      // A check already running stands in for the baseline. Without credits
      // the schedule still saves, and the tracker says why no check ran.
      const runInProgress =
        error instanceof AiVisibilityError &&
        error.reason === "RUN_IN_PROGRESS";
      const noCredits =
        error instanceof AppError && error.code === "INSUFFICIENT_CREDITS";
      if (!runInProgress && !noCredits) throw error;
    }
  }
  return { state: await getTracker(input), run };
}

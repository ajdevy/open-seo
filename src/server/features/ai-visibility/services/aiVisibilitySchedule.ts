import { AiVisibilityRepository as repo } from "../repositories/AiVisibilityRepository";
import { AiVisibilityError } from "./aiVisibilityErrors";
import { activeAiPrompts } from "./aiVisibilityConfiguration";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import type { AiRun } from "@/shared/ai-visibility";
import type { SetAiScheduleInput } from "@/types/schemas/ai-visibility";
import { computeNextCheckAt } from "@/shared/rank-tracking";
import {
  DEFAULT_AI_WEEKLY_SCHEDULE,
  computeNextAiWallClockCheckAt,
  ScheduleTimeResolutionError,
} from "@/shared/ai-visibility-schedule";
import { requireConfiguration } from "./aiVisibilityMutation";
import { getTracker } from "./aiVisibilityState";
import { hasDataforseoAccess } from "@/server/lib/provider-access";

/**
 * Enables, reschedules or pauses tracking. Enabling saves the next scheduled
 * slot; it does not start a paid baseline check immediately.
 */
export async function setSchedule(
  input: SetAiScheduleInput,
  _billing: BillingCustomerContext,
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
  const savedWallClock =
    scheduleInterval === "weekly" &&
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
  const explicitWallClock =
    scheduleInterval !== "weekly"
      ? null
      : input.scheduleTime?.timeZone && input.scheduleTime.weekday !== undefined
        ? {
            weekday: input.scheduleTime.weekday,
            hour: input.scheduleTime.hour,
            minute: input.scheduleTime.minute,
            timeZone: input.scheduleTime.timeZone,
          }
        : input.scheduleTime
          ? null
          : (savedWallClock ?? DEFAULT_AI_WEEKLY_SCHEDULE);
  const applyingDefaultWeeklySchedule =
    scheduleInterval === "weekly" &&
    input.scheduleTime === undefined &&
    savedWallClock === null;
  // The stored next check is the chosen slot. An unchanged schedule keeps it.
  let nextCheckAt = tracker.nextCheckAt;
  if (
    input.scheduleTime ||
    scheduleInterval !== tracker.scheduleInterval ||
    applyingDefaultWeeklySchedule ||
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
    scheduleInterval !== tracker.scheduleInterval ||
    applyingDefaultWeeklySchedule;
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
  return { state: await getTracker(input), run: null };
}

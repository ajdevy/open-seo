import { sort } from "remeda";

export interface AiWeeklyWallClockSchedule {
  weekday: number;
  hour: number;
  minute: number;
  timeZone: string;
}

export const DEFAULT_AI_WEEKLY_SCHEDULE: AiWeeklyWallClockSchedule = {
  weekday: 3,
  hour: 10,
  minute: 0,
  timeZone: "Europe/Moscow",
};

export interface MissedAiWeeklyWallClockSlot {
  localDate: string;
  resolution: "valid" | "nonexistent" | "ambiguous";
}

export class ScheduleTimeResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleTimeResolutionError";
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();
const WEEK_MS = 7 * 24 * 60 * 60_000;

function formatter(timeZone: string) {
  let result = formatters.get(timeZone);
  if (!result) {
    result = new Intl.DateTimeFormat("en-US", {
      calendar: "gregory",
      numberingSystem: "latn",
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(timeZone, result);
  }
  return result;
}

function localParts(instant: number, timeZone: string) {
  const parts = formatter(timeZone).formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second"),
  };
}

function utcTimestamp(parts: {
  year: number;
  month: number;
  day: number;
  hour?: number;
  minute?: number;
  second?: number;
}) {
  const date = new Date(0);
  date.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  date.setUTCHours(parts.hour ?? 0, parts.minute ?? 0, parts.second ?? 0, 0);
  return date.getTime();
}

function sameWallTime(
  parts: ReturnType<typeof localParts>,
  date: { year: number; month: number; day: number },
  time: { hour: number; minute: number },
) {
  return (
    parts.year === date.year &&
    parts.month === date.month &&
    parts.day === date.day &&
    parts.hour === time.hour &&
    parts.minute === time.minute &&
    parts.second === 0
  );
}

function daysUntilScheduledWeekday(
  schedule: AiWeeklyWallClockSchedule,
  date: Date,
) {
  if (
    !Number.isInteger(schedule.weekday) ||
    schedule.weekday < 0 ||
    schedule.weekday > 6
  )
    throw new ScheduleTimeResolutionError(
      "A weekly local-time schedule requires an explicitly selected weekday.",
    );
  return (schedule.weekday - date.getUTCDay() + 7) % 7;
}

function localDateLabel(date: { year: number; month: number; day: number }) {
  return [
    date.year,
    String(date.month).padStart(2, "0"),
    String(date.day).padStart(2, "0"),
  ].join("-");
}

/**
 * Resolve a local wall time, rejecting DST gaps/folds by default. Scheduled
 * recurrence may instead skip and report an unresolved future occurrence.
 */
function resolveWallTime(
  date: { year: number; month: number; day: number },
  time: { hour: number; minute: number },
  timeZone: string,
) {
  const wallTimestamp = utcTimestamp({ ...date, ...time });
  const offsets = new Set<number>();

  // Sample both sides of any nearby offset change so a repeated wall time
  // yields both candidate instants and a skipped wall time yields none.
  for (let hours = -48; hours <= 48; hours += 6) {
    const instant = wallTimestamp + hours * 3_600_000;
    const local = localParts(instant, timeZone);
    offsets.add((utcTimestamp(local) - instant) / 60_000);
  }

  const matches = sort(
    [...offsets]
      .map((offset) => wallTimestamp - offset * 60_000)
      .filter((instant) =>
        sameWallTime(localParts(instant, timeZone), date, time),
      ),
    (a, b) => a - b,
  );

  return matches;
}

function nextLocalDate(
  schedule: AiWeeklyWallClockSchedule,
  after: number,
  unresolvedOccurrencePolicy: "reject" | "skip" = "reject",
  previousDueAt?: number,
) {
  const local = localParts(after, schedule.timeZone);
  const date = new Date(utcTimestamp(local));
  const daysAhead = daysUntilScheduledWeekday(schedule, date);
  date.setUTCDate(date.getUTCDate() + daysAhead);

  const skippedLocalDates: string[] = [];
  const maxAttempts = unresolvedOccurrencePolicy === "skip" ? 8 : 3;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const dateParts = {
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
    };
    const matches = resolveWallTime(dateParts, schedule, schedule.timeZone);
    const upcoming = matches.filter((instant) => instant > after);
    if (matches.length === 1 && upcoming.length === 1)
      return { instant: upcoming[0], skippedLocalDates };

    const sameLocalDate =
      dateParts.year === local.year &&
      dateParts.month === local.month &&
      dateParts.day === local.day;
    const wallTimeAlreadyPassed =
      schedule.hour < local.hour ||
      (schedule.hour === local.hour &&
        (schedule.minute < local.minute ||
          (schedule.minute === local.minute && local.second > 0)));
    const nonexistentTimeAlreadyPassed =
      previousDueAt === undefined &&
      matches.length === 0 &&
      sameLocalDate &&
      wallTimeAlreadyPassed;
    const ambiguousTimeAlreadyPassed =
      previousDueAt === undefined &&
      matches.length > 1 &&
      upcoming.length === 0;
    const unresolvedOccurrence =
      (matches.length === 0 && !nonexistentTimeAlreadyPassed) ||
      (matches.length > 1 && !ambiguousTimeAlreadyPassed);
    if (unresolvedOccurrence) {
      const dateLabel = localDateLabel(dateParts);
      const message =
        matches.length === 0
          ? `The selected local time does not exist in ${schedule.timeZone} on ${dateLabel}; choose another schedule time.`
          : `The selected local time occurs twice in ${schedule.timeZone} on ${dateLabel}; choose another schedule time.`;
      if (unresolvedOccurrencePolicy === "reject")
        throw new ScheduleTimeResolutionError(message);
      skippedLocalDates.push(dateLabel);
    }

    date.setUTCDate(date.getUTCDate() + 7);
  }
  throw new ScheduleTimeResolutionError(
    "Could not resolve the next scheduled local-time occurrence.",
  );
}

function skippedLocalDatesSinceDue(
  schedule: AiWeeklyWallClockSchedule,
  previousDueAt: number | undefined,
  now: number,
) {
  if (previousDueAt === undefined || previousDueAt >= now) return [];

  const dueLocal = localParts(previousDueAt, schedule.timeZone);
  const date = new Date(utcTimestamp(dueLocal));
  const daysAhead = daysUntilScheduledWeekday(schedule, date);
  date.setUTCDate(date.getUTCDate() + daysAhead);
  const scheduledTimeIsAfterDueTime =
    schedule.hour > dueLocal.hour ||
    (schedule.hour === dueLocal.hour && schedule.minute > dueLocal.minute);
  if (daysAhead === 0 && !scheduledTimeIsAfterDueTime)
    date.setUTCDate(date.getUTCDate() + 7);

  const today = new Date(utcTimestamp(localParts(now, schedule.timeZone)));
  const skippedLocalDates: string[] = [];
  for (
    let localDateAt = date.getTime();
    localDateAt < today.getTime();
    localDateAt += WEEK_MS
  ) {
    const localDate = new Date(localDateAt);
    const dateParts = {
      year: localDate.getUTCFullYear(),
      month: localDate.getUTCMonth() + 1,
      day: localDate.getUTCDate(),
    };
    if (resolveWallTime(dateParts, schedule, schedule.timeZone).length !== 1)
      skippedLocalDates.push(localDateLabel(dateParts));
  }
  return skippedLocalDates;
}

/**
 * List each weekly wall-clock slot at or after the saved due date that has
 * passed. DST gaps and folds stay in the list with their resolution so the
 * scheduler can explain why those dates were skipped to the user.
 */
export function listMissedAiWeeklyWallClockSlots(
  schedule: AiWeeklyWallClockSchedule,
  previousNextCheckAt: string,
): MissedAiWeeklyWallClockSlot[] {
  const { now, previousDueAt } = scheduleAnchor(previousNextCheckAt);
  if (previousDueAt === undefined || previousDueAt > now) return [];

  const dueLocal = localParts(previousDueAt, schedule.timeZone);
  const dueDate = new Date(utcTimestamp(dueLocal));
  const dueDateLabel = localDateLabel(dueLocal);
  const daysAhead = daysUntilScheduledWeekday(schedule, dueDate);
  dueDate.setUTCDate(dueDate.getUTCDate() + daysAhead);

  const nowLocal = localParts(now, schedule.timeZone);
  const lastLocalDate = new Date(utcTimestamp(nowLocal));
  const lastLocalDateAt = lastLocalDate.getTime();
  const wallClockTimePassed =
    nowLocal.hour > schedule.hour ||
    (nowLocal.hour === schedule.hour && nowLocal.minute >= schedule.minute);
  const missed: MissedAiWeeklyWallClockSlot[] = [];

  for (
    let localDateAt = dueDate.getTime();
    localDateAt <= lastLocalDateAt;
    localDateAt += WEEK_MS
  ) {
    const localDateObject = new Date(localDateAt);
    const date = {
      year: localDateObject.getUTCFullYear(),
      month: localDateObject.getUTCMonth() + 1,
      day: localDateObject.getUTCDate(),
    };
    const localDate = localDateLabel(date);
    const matches = resolveWallTime(date, schedule, schedule.timeZone);
    const isSavedDueDate = localDate === dueDateLabel;
    const hasPassed =
      isSavedDueDate ||
      (matches.length === 0
        ? localDateAt < lastLocalDateAt || wallClockTimePassed
        : matches.some((instant) => instant <= now));

    if (hasPassed) {
      missed.push({
        localDate,
        resolution:
          matches.length === 0
            ? "nonexistent"
            : matches.length > 1
              ? "ambiguous"
              : "valid",
      });
    }
  }

  return missed;
}

/**
 * Compute the next explicit weekly IANA wall-clock occurrence. Daily and
 * monthly schedules keep their existing UTC-anchor recurrence.
 */
export function computeNextAiWallClockCheckAt(
  schedule: AiWeeklyWallClockSchedule,
  previousNextCheckAt?: string | null,
): string {
  const { after } = scheduleAnchor(previousNextCheckAt);
  return new Date(nextLocalDate(schedule, after).instant).toISOString();
}

/**
 * Scheduler recurrence policy: skip and report nonexistent or repeated future
 * wall-clock slots. The caller decides whether the saved due slot is still
 * within its start grace period.
 */
export function computeNextAiWallClockCheckAtSkippingUnresolved(
  schedule: AiWeeklyWallClockSchedule,
  previousNextCheckAt?: string | null,
): { nextCheckAt: string; skippedLocalDates: string[] } {
  const { now, after, previousDueAt } = scheduleAnchor(previousNextCheckAt);
  const { instant, skippedLocalDates } = nextLocalDate(
    schedule,
    after,
    "skip",
    previousDueAt,
  );
  const skippedDates = new Set([
    ...skippedLocalDatesSinceDue(schedule, previousDueAt, now),
    ...skippedLocalDates,
  ]);
  return {
    nextCheckAt: new Date(instant).toISOString(),
    skippedLocalDates: sort([...skippedDates], (a, b) => a.localeCompare(b)),
  };
}

function scheduleAnchor(previousNextCheckAt?: string | null) {
  const now = Date.now();
  const previousDueAt = previousNextCheckAt
    ? new Date(previousNextCheckAt).getTime()
    : undefined;
  if (
    !Number.isFinite(now) ||
    (previousDueAt !== undefined && !Number.isFinite(previousDueAt))
  )
    throw new ScheduleTimeResolutionError(
      "The saved schedule anchor is not a valid timestamp.",
    );
  return {
    now,
    after: Math.max(now, previousDueAt ?? Number.NEGATIVE_INFINITY),
    previousDueAt,
  };
}

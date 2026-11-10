import { sort } from "remeda";

export interface AiWeeklyWallClockSchedule {
  weekday: number;
  hour: number;
  minute: number;
  timeZone: string;
}

export class ScheduleTimeResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleTimeResolutionError";
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();

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
) {
  const local = localParts(after, schedule.timeZone);
  const date = new Date(utcTimestamp(local));
  if (
    !Number.isInteger(schedule.weekday) ||
    schedule.weekday < 0 ||
    schedule.weekday > 6
  )
    throw new ScheduleTimeResolutionError(
      "A weekly local-time schedule requires an explicitly selected weekday.",
    );
  const daysAhead = (schedule.weekday - date.getUTCDay() + 7) % 7;
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
      matches.length === 0 && sameLocalDate && wallTimeAlreadyPassed;
    const ambiguousTimeAlreadyPassed =
      matches.length > 1 && upcoming.length === 0;
    const unresolvedOccurrence =
      (matches.length === 0 && !nonexistentTimeAlreadyPassed) ||
      (matches.length > 1 && !ambiguousTimeAlreadyPassed);
    if (unresolvedOccurrence) {
      const dateLabel = [
        dateParts.year,
        String(dateParts.month).padStart(2, "0"),
        String(dateParts.day).padStart(2, "0"),
      ].join("-");
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

/**
 * Compute the next explicit weekly IANA wall-clock occurrence. Daily and
 * monthly schedules keep their existing UTC-anchor recurrence.
 */
export function computeNextAiWallClockCheckAt(
  schedule: AiWeeklyWallClockSchedule,
  previousNextCheckAt?: string | null,
): string {
  const after = scheduleAnchor(previousNextCheckAt);
  return new Date(nextLocalDate(schedule, after).instant).toISOString();
}

/**
 * Scheduler recurrence policy: skip and report nonexistent or repeated future
 * wall-clock slots, while still starting the currently due occurrence.
 */
export function computeNextAiWallClockCheckAtSkippingUnresolved(
  schedule: AiWeeklyWallClockSchedule,
  previousNextCheckAt?: string | null,
): { nextCheckAt: string; skippedLocalDates: string[] } {
  const { instant, skippedLocalDates } = nextLocalDate(
    schedule,
    scheduleAnchor(previousNextCheckAt),
    "skip",
  );
  return {
    nextCheckAt: new Date(instant).toISOString(),
    skippedLocalDates,
  };
}

function scheduleAnchor(previousNextCheckAt?: string | null) {
  const now = Date.now();
  const previous = previousNextCheckAt
    ? new Date(previousNextCheckAt).getTime()
    : Number.NEGATIVE_INFINITY;
  if (
    !Number.isFinite(now) ||
    (!Number.isFinite(previous) && previous !== Number.NEGATIVE_INFINITY)
  )
    throw new ScheduleTimeResolutionError(
      "The saved schedule anchor is not a valid timestamp.",
    );
  return Math.max(now, previous);
}

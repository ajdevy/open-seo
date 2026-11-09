import { afterEach, describe, expect, it, vi } from "vitest";
import {
  computeNextAiWallClockCheckAt,
  ScheduleTimeResolutionError,
} from "./ai-visibility-schedule";

const sundayAtNine = {
  weekday: 0,
  hour: 9,
  minute: 0,
  timeZone: "America/New_York",
};

afterEach(() => vi.useRealTimers());

describe("IANA wall-clock AI schedules", () => {
  it.each([
    {
      label: "spring DST",
      now: "2026-03-01T14:01:00.000Z",
      previous: "2026-03-01T14:00:00.000Z",
      expected: "2026-03-08T13:00:00.000Z",
    },
    {
      label: "after spring DST",
      now: "2026-03-08T13:01:00.000Z",
      previous: "2026-03-08T13:00:00.000Z",
      expected: "2026-03-15T13:00:00.000Z",
    },
    {
      label: "fall DST",
      now: "2026-10-25T13:01:00.000Z",
      previous: "2026-10-25T13:00:00.000Z",
      expected: "2026-11-01T14:00:00.000Z",
    },
    {
      label: "after fall DST",
      now: "2026-11-01T14:01:00.000Z",
      previous: "2026-11-01T14:00:00.000Z",
      expected: "2026-11-08T14:00:00.000Z",
    },
  ])(
    "keeps the selected weekday and hour through $label",
    ({ now, previous, expected }) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(now));

      expect(computeNextAiWallClockCheckAt(sundayAtNine, previous)).toBe(
        expected,
      );
    },
  );

  it("uses the selected wall-clock time for the first occurrence", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-01T12:00:00.000Z"));

    expect(computeNextAiWallClockCheckAt(sundayAtNine)).toBe(
      "2026-03-01T14:00:00.000Z",
    );
  });

  it.each([
    {
      time: { ...sundayAtNine, hour: 2, minute: 30 },
      previous: "2026-03-01T07:30:00.000Z",
      now: "2026-03-01T07:31:00.000Z",
      message: /does not exist in America\/New_York on 2026-03-08/,
    },
    {
      time: { ...sundayAtNine, hour: 1, minute: 30 },
      previous: "2026-10-25T05:30:00.000Z",
      now: "2026-10-25T05:31:00.000Z",
      message: /occurs twice in America\/New_York on 2026-11-01/,
    },
  ])(
    "rejects unresolved DST wall times",
    ({ time, previous, now, message }) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(now));

      const compute = () => computeNextAiWallClockCheckAt(time, previous);
      expect(compute).toThrow(ScheduleTimeResolutionError);
      expect(compute).toThrow(message);
    },
  );
});

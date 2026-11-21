import { expect, it } from "vitest";
import {
  describeSchedule,
  scheduleTimeForAiVisibilityRequest,
  withBrowserTimeZone,
} from "./scheduleTime";

it("preserves and describes an explicit IANA schedule timezone", () => {
  const schedule = {
    weekday: 3,
    hour: 10,
    minute: 0,
    timeZone: "Europe/Moscow",
  };

  expect(withBrowserTimeZone(schedule)).toEqual(schedule);
  expect(describeSchedule("weekly", schedule)).toMatch(
    /weekly on Wednesdays at .*10:00.*\(Europe\/Moscow\)/,
  );
});

it("omits weekday and timezone from non-weekly AI schedule request times", () => {
  const browserTime = {
    weekday: 3,
    hour: 10,
    minute: 30,
    timeZone: "Europe/Berlin",
  };

  expect(scheduleTimeForAiVisibilityRequest("daily", browserTime)).toEqual({
    hour: 10,
    minute: 30,
  });
  expect(scheduleTimeForAiVisibilityRequest("monthly", browserTime)).toEqual({
    hour: 10,
    minute: 30,
  });
});

it("adds the browser timezone only for weekly AI schedule request times", () => {
  expect(
    scheduleTimeForAiVisibilityRequest("weekly", {
      weekday: 3,
      hour: 10,
      minute: 30,
      timeZone: "Europe/Berlin",
    }),
  ).toEqual({
    weekday: 3,
    hour: 10,
    minute: 30,
    timeZone: "Europe/Berlin",
  });
});

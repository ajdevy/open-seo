import { expect, it } from "vitest";
import { describeSchedule, withBrowserTimeZone } from "./scheduleTime";

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

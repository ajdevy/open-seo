import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AiVisibilityRepository as repo } from "../repositories/AiVisibilityRepository";
import { setSchedule } from "./aiVisibilitySchedule";
import { configuration, customer } from "./aiVisibilityTestFixtures";
import { setAiScheduleSchema } from "@/types/schemas/ai-visibility";
import { AiVisibilityError } from "./aiVisibilityErrors";

const { testDb, hasDataforseoAccess, startRun } = await vi.hoisted(async () => {
  const { createAiVisibilityTestDb } = await import("../aiVisibilityTestDb");
  return {
    testDb: await createAiVisibilityTestDb(),
    hasDataforseoAccess: vi.fn(),
    startRun: vi.fn(),
  };
});
vi.mock("cloudflare:workers", () => ({
  env: { DATABASE_PROVIDER: "d1", AI_VISIBILITY_WORKFLOW: { create: vi.fn() } },
}));
vi.mock("@/db", () => ({ db: testDb.db }));
vi.mock("@/db/runBatch", () => ({ runBatch: testDb.runBatch }));
vi.mock("@/server/lib/provider-access", () => ({ hasDataforseoAccess }));
vi.mock("./aiVisibilityRuns", () => ({ startRun }));

beforeEach(async () => {
  hasDataforseoAccess.mockResolvedValue(true);
  startRun.mockResolvedValue(null);
  await testDb.seedProject();
  await repo.saveConfiguration(configuration());
});

afterEach(() => vi.useRealTimers());

it("persists and returns an explicit IANA weekly slot, and preserves it on pause", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-03-01T12:00:00.000Z"));

  const saved = await setSchedule(
    {
      projectId: "project",
      enabled: true,
      scheduleInterval: "weekly",
      scheduleTime: {
        weekday: 0,
        hour: 9,
        minute: 15,
        timeZone: "America/New_York",
      },
    },
    customer,
  );

  expect(saved.state.tracker).toMatchObject({
    scheduleInterval: "weekly",
    scheduleWeekday: 0,
    scheduleHour: 9,
    scheduleMinute: 15,
    scheduleTimeZone: "America/New_York",
    nextCheckAt: "2026-03-01T14:15:00.000Z",
  });

  await setSchedule({ projectId: "project", enabled: false }, customer);
  expect(await repo.getTracker("project")).toMatchObject({
    enabled: false,
    scheduleWeekday: 0,
    scheduleHour: 9,
    scheduleMinute: 15,
    scheduleTimeZone: "America/New_York",
  });
});

it("replaces explicit recurrence settings on reschedule", async () => {
  const saved = await repo.getTracker("project");
  if (!saved) throw new Error("Tracker fixture was not saved.");
  await repo.updateTracker(saved.id, {
    enabled: true,
    scheduleInterval: "weekly",
    scheduleWeekday: 0,
    scheduleHour: 9,
    scheduleMinute: 15,
    scheduleTimeZone: "America/New_York",
    nextCheckAt: "2026-03-01T14:15:00.000Z",
  });

  const result = await setSchedule(
    {
      projectId: "project",
      enabled: true,
      scheduleInterval: "daily",
      scheduleTime: {
        hour: 10,
        minute: 30,
        timeZone: "Europe/Berlin",
      },
    },
    customer,
  );

  expect(result.state.tracker).toMatchObject({
    scheduleInterval: "daily",
    scheduleWeekday: null,
    scheduleHour: 10,
    scheduleMinute: 30,
    scheduleTimeZone: "Europe/Berlin",
  });
});

it("rejects an invalid IANA timezone before the schedule is saved", async () => {
  const parsed = setAiScheduleSchema.safeParse({
    projectId: "project",
    enabled: true,
    scheduleTime: {
      weekday: 0,
      hour: 9,
      minute: 0,
      timeZone: "Mars/Olympus_Mons",
    },
  });

  expect(parsed.success).toBe(false);
  expect((await repo.getTracker("project"))?.scheduleTimeZone).toBeNull();
});

it("refuses to save a weekly recurrence with an ambiguous next wall time", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-25T05:31:00.000Z"));

  const result = setSchedule(
    {
      projectId: "project",
      enabled: true,
      scheduleInterval: "weekly",
      scheduleTime: {
        weekday: 0,
        hour: 1,
        minute: 30,
        timeZone: "America/New_York",
      },
    },
    customer,
  );
  await expect(result).rejects.toBeInstanceOf(AiVisibilityError);
  await expect(result).rejects.toThrow(/occurs twice.*2026-11-01/);

  expect((await repo.getTracker("project"))?.scheduleTimeZone).toBeNull();
});

it("keeps timezone-unconfigured schedules on the legacy anchor path", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-03-01T08:00:00.000Z"));
  const result = await setSchedule(
    {
      projectId: "project",
      enabled: true,
      scheduleInterval: "weekly",
      scheduleTime: { weekday: 0, hour: 9, minute: 15 },
    },
    customer,
  );

  expect(result.state.tracker).toMatchObject({
    scheduleWeekday: null,
    scheduleHour: null,
    scheduleMinute: null,
    scheduleTimeZone: null,
    nextCheckAt: "2026-03-01T09:15:00.000Z",
  });
});

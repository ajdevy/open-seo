import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AiVisibilityRepository as repo } from "../repositories/AiVisibilityRepository";
import { setSchedule } from "./aiVisibilitySchedule";
import { configuration, customer } from "./aiVisibilityTestFixtures";
import { setAiScheduleSchema } from "@/types/schemas/ai-visibility";
import { AiVisibilityError } from "./aiVisibilityErrors";

const { testDb, hasDataforseoAccess } = await vi.hoisted(async () => {
  const { createAiVisibilityTestDb } = await import("../aiVisibilityTestDb");
  return {
    testDb: await createAiVisibilityTestDb(),
    hasDataforseoAccess: vi.fn(),
  };
});
vi.mock("cloudflare:workers", () => ({
  env: { DATABASE_PROVIDER: "d1", AI_VISIBILITY_WORKFLOW: { create: vi.fn() } },
}));
vi.mock("@/db", () => ({ db: testDb.db }));
vi.mock("@/db/runBatch", () => ({ runBatch: testDb.runBatch }));
vi.mock("@/server/lib/runtime-env", () => ({
  getOptionalEnvValue: async (name: string) =>
    name === "AUTOGEO_QUEUE_MASTER_KEY_B64" ? btoa("k".repeat(32)) : undefined,
}));
vi.mock("@/server/lib/provider-access", () => ({ hasDataforseoAccess }));

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-16T06:00:00.000Z"));
  hasDataforseoAccess.mockResolvedValue(true);
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

it("rejects a weekly timezone schedule without a weekday before saving", async () => {
  const input = {
    projectId: "project",
    enabled: true,
    scheduleInterval: "weekly" as const,
    scheduleTime: {
      hour: 9,
      minute: 15,
      timeZone: "America/New_York",
    },
  };

  expect(setAiScheduleSchema.safeParse(input).success).toBe(false);
  const before = await repo.getTracker("project");
  if (!before) throw new Error("Tracker fixture was not saved.");

  await expect(setSchedule(input, customer)).rejects.toMatchObject({
    reason: "INVALID_SCHEDULE_TIME",
  });

  expect(await repo.getTracker("project")).toEqual(before);
});

it("keeps a new tracker paused when provider access is missing", async () => {
  hasDataforseoAccess.mockResolvedValue(false);

  await expect(
    setSchedule(
      { projectId: "project", enabled: true, scheduleInterval: "weekly" },
      customer,
    ),
  ).rejects.toMatchObject({ reason: "PROVIDER_NOT_CONFIGURED" });

  expect(await repo.getTracker("project")).toMatchObject({
    enabled: false,
    scheduleInterval: "weekly",
    scheduleWeekday: null,
    scheduleHour: null,
    scheduleMinute: null,
    scheduleTimeZone: null,
    nextCheckAt: null,
  });
});

it("persists a paused state when a tracker configuration is updated", async () => {
  const tracker = await repo.getTracker("project");
  if (!tracker) throw new Error("Tracker fixture was not saved.");
  await repo.updateTracker(tracker.id, { enabled: true });

  const config = await repo.getConfiguration("project");
  if (!config) throw new Error("Tracker fixture was not saved.");
  config.tracker.enabled = false;
  await repo.saveConfiguration(config);

  expect((await repo.getTracker("project"))?.enabled).toBe(false);
});

it("keeps a new tracker paused when it has no active prompts", async () => {
  hasDataforseoAccess.mockClear();
  const rows = await repo.getConfiguration("project");
  if (!rows) throw new Error("Tracker fixture was not saved.");
  const [prompt] = rows.prompts;
  if (!prompt) throw new Error("Prompt fixture was not saved.");
  prompt.paused = true;
  await repo.saveConfiguration(rows);

  await expect(
    setSchedule(
      { projectId: "project", enabled: true, scheduleInterval: "weekly" },
      customer,
    ),
  ).rejects.toMatchObject({ reason: "NO_ACTIVE_PROMPTS" });

  expect(await repo.getTracker("project")).toMatchObject({
    enabled: false,
    scheduleWeekday: null,
    scheduleHour: null,
    scheduleMinute: null,
    scheduleTimeZone: null,
    nextCheckAt: null,
  });
  expect(hasDataforseoAccess).not.toHaveBeenCalled();
});

it("keeps a new tracker paused when its observation scope has no engines", async () => {
  hasDataforseoAccess.mockClear();
  const rows = await repo.getConfiguration("project");
  if (!rows) throw new Error("Tracker fixture was not saved.");
  Object.assign(rows.tracker, {
    chatgpt: false,
    gemini: false,
    googleAiOverview: false,
    claude: false,
    perplexity: false,
  });
  await repo.saveConfiguration(rows);

  await expect(
    setSchedule(
      { projectId: "project", enabled: true, scheduleInterval: "weekly" },
      customer,
    ),
  ).rejects.toMatchObject({ reason: "NO_ACTIVE_ENGINES" });

  expect((await repo.getTracker("project"))?.enabled).toBe(false);
  expect(hasDataforseoAccess).not.toHaveBeenCalled();
});

it("ignores weekly-only fields when pausing a schedule", async () => {
  const before = await repo.getTracker("project");
  if (!before) throw new Error("Tracker fixture was not saved.");
  const input = {
    projectId: "project",
    enabled: false,
    scheduleInterval: "weekly" as const,
    scheduleTime: {
      hour: 9,
      minute: 15,
      timeZone: "America/New_York",
    },
  };

  expect(
    setAiScheduleSchema.safeParse({
      ...input,
      projectId: "00000000-0000-4000-8000-000000000001",
    }).success,
  ).toBe(true);
  await setSchedule(input, customer);

  expect(await repo.getTracker("project")).toMatchObject({
    enabled: false,
    scheduleInterval: before.scheduleInterval,
    scheduleWeekday: before.scheduleWeekday,
    scheduleHour: before.scheduleHour,
    scheduleMinute: before.scheduleMinute,
    scheduleTimeZone: before.scheduleTimeZone,
  });
});

it("defaults a new weekly schedule to Wednesday at 10 in Moscow without a baseline run", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-16T06:00:00.000Z"));

  const saved = await setSchedule(
    { projectId: "project", enabled: true, scheduleInterval: "weekly" },
    customer,
  );

  expect(saved.run).toBeNull();
  expect(saved.state.tracker).toMatchObject({
    enabled: true,
    scheduleInterval: "weekly",
    scheduleWeekday: 3,
    scheduleHour: 10,
    scheduleMinute: 0,
    scheduleTimeZone: "Europe/Moscow",
    nextCheckAt: "2026-11-18T07:00:00.000Z",
  });
});

it("clears weekly wall-clock settings when rescheduling another cadence", async () => {
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
      scheduleInterval: "monthly",
      scheduleTime: {
        hour: 10,
        minute: 30,
        timeZone: "Europe/Berlin",
      },
    },
    customer,
  );

  expect(result.state.tracker).toMatchObject({
    scheduleInterval: "monthly",
    scheduleWeekday: null,
    scheduleHour: null,
    scheduleMinute: null,
    scheduleTimeZone: null,
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

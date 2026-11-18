import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AiVisibilityRepository as repo } from "../repositories/AiVisibilityRepository";
import { setSchedule } from "./aiVisibilitySchedule";
import { configuration, customer } from "./aiVisibilityTestFixtures";
import { setAiScheduleSchema } from "@/types/schemas/ai-visibility";

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
vi.mock("@/server/lib/runtime-env", () => ({
  getOptionalEnvValue: async (name: string) =>
    name === "AUTOGEO_QUEUE_MASTER_KEY_B64" ? btoa("k".repeat(32)) : undefined,
}));

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-16T06:00:00.000Z"));
  hasDataforseoAccess.mockResolvedValue(true);
  await testDb.seedProject();
  await repo.saveConfiguration(configuration());
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

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

it("cancels a queued scheduled run atomically when tracking is paused", async () => {
  const enabled = await setSchedule(
    { projectId: "project", enabled: true, scheduleInterval: "weekly" },
    customer,
  );
  const trackerId = enabled.state.tracker?.id;
  if (!trackerId) throw new Error("Enabled tracker was not saved.");
  const config = await repo.getConfiguration("project");
  if (!config) throw new Error("Tracker fixture was not saved.");
  const prompt = config.prompts[0];
  if (!prompt) throw new Error("Prompt fixture was not saved.");
  const runId = "queued-scheduled-before-pause";
  await repo.createRun(
    {
      id: runId,
      trackerId: config.tracker.id,
      projectId: "project",
      trigger: "scheduled",
      locationCode: config.tracker.locationCode,
      languageCode: config.tracker.languageCode,
      createdAt: "2026-11-16T06:00:00.000Z",
    },
    [
      {
        id: "queued-scheduled-before-pause-answer",
        runId,
        promptId: prompt.id,
        engine: "chatgpt",
        branded: false,
      },
    ],
  );
  await repo.updateTracker(trackerId, {
    pendingScheduledRunId: runId,
  });

  await setSchedule({ projectId: "project", enabled: false }, customer);

  expect(await repo.getTracker("project")).toMatchObject({
    enabled: false,
    pendingScheduledRunId: null,
    lastSkipReason: "Scheduled tracking is paused.",
  });
  expect(await repo.getRunInternal(runId)).toMatchObject({ status: "failed" });
  expect(await repo.getObservations([runId])).toMatchObject([
    {
      status: "failed",
      error: "Scheduled tracking is paused.",
    },
  ]);
});

it("cancels a queued scheduled run when the saved prompt scope changes", async () => {
  const enabled = await setSchedule(
    { projectId: "project", enabled: true, scheduleInterval: "weekly" },
    customer,
  );
  const trackerId = enabled.state.tracker?.id;
  if (!trackerId) throw new Error("Enabled tracker was not saved.");
  const config = await repo.getConfiguration("project");
  if (!config) throw new Error("Tracker fixture was not saved.");
  const prompt = config.prompts[0];
  if (!prompt) throw new Error("Prompt fixture was not saved.");
  const runId = "queued-scheduled-before-scope-change";
  await repo.createRun(
    {
      id: runId,
      trackerId: config.tracker.id,
      projectId: "project",
      trigger: "scheduled",
      locationCode: config.tracker.locationCode,
      languageCode: config.tracker.languageCode,
      createdAt: "2026-11-16T06:00:00.000Z",
    },
    [
      {
        id: "queued-scheduled-before-scope-change-answer",
        runId,
        promptId: prompt.id,
        engine: "chatgpt",
        branded: false,
      },
    ],
  );
  await repo.updateTracker(trackerId, {
    pendingScheduledRunId: runId,
  });

  await repo.saveConfiguration({
    ...config,
    prompts: config.prompts.map((savedPrompt) =>
      savedPrompt.id === prompt.id
        ? { ...savedPrompt, paused: true }
        : savedPrompt,
    ),
  });

  const tracker = await repo.getTracker("project");
  expect(tracker).toMatchObject({
    enabled: true,
    pendingScheduledRunId: null,
  });
  expect(tracker?.lastSkipReason).toMatch(/tracking settings changed/);
  expect(await repo.getRunInternal(runId)).toMatchObject({ status: "failed" });
  const [observation] = await repo.getObservations([runId]);
  expect(observation?.status).toBe("failed");
  expect(observation?.error).toMatch(/tracking settings changed/);
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

  expect(
    setAiScheduleSchema.safeParse({
      ...input,
      projectId: "00000000-0000-4000-8000-000000000001",
    }).success,
  ).toBe(false);
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

it("rejects enabling when prompts are removed after the initial validation", async () => {
  const updateTracker = repo.updateTracker.bind(repo);
  vi.spyOn(repo, "updateTracker").mockImplementation(async (id, values) => {
    const current = await repo.getConfiguration("project");
    if (!current) throw new Error("Tracker fixture was not saved.");
    await repo.saveConfiguration({
      ...current,
      prompts: current.prompts.map((prompt) => ({ ...prompt, paused: true })),
    });
    return updateTracker(id, values);
  });

  await expect(
    setSchedule(
      { projectId: "project", enabled: true, scheduleInterval: "weekly" },
      customer,
    ),
  ).rejects.toMatchObject({ reason: "NO_ACTIVE_PROMPTS" });

  expect(await repo.getTracker("project")).toMatchObject({ enabled: false });
});

it("rejects enabling when engines are removed after the initial validation", async () => {
  const updateTracker = repo.updateTracker.bind(repo);
  vi.spyOn(repo, "updateTracker").mockImplementation(async (id, values) => {
    const current = await repo.getConfiguration("project");
    if (!current) throw new Error("Tracker fixture was not saved.");
    await repo.saveConfiguration({
      ...current,
      tracker: {
        ...current.tracker,
        chatgpt: false,
        gemini: false,
        googleAiOverview: false,
        claude: false,
        perplexity: false,
      },
    });
    return updateTracker(id, values);
  });

  await expect(
    setSchedule(
      { projectId: "project", enabled: true, scheduleInterval: "weekly" },
      customer,
    ),
  ).rejects.toMatchObject({ reason: "NO_ACTIVE_ENGINES" });

  expect(await repo.getTracker("project")).toMatchObject({ enabled: false });
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

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { aiPrompts, aiTrackers, projects } from "@/db/schema";
import { AiVisibilityRepository as repo } from "../repositories/AiVisibilityRepository";
import { runScheduledAiVisibility } from "./scheduledAiVisibility";
import { configuration } from "./aiVisibilityTestFixtures";

const { testDb, workflow, hosted } = await vi.hoisted(async () => {
  const { createAiVisibilityTestDb } = await import("../aiVisibilityTestDb");
  return {
    testDb: await createAiVisibilityTestDb(),
    workflow: {
      create: vi.fn(),
      get: vi.fn(async () => ({
        status: async () => ({ status: "queued" }),
      })),
    },
    hosted: vi.fn(),
  };
});
vi.mock("cloudflare:workers", () => ({
  env: { DATABASE_PROVIDER: "d1", AI_VISIBILITY_WORKFLOW: workflow },
}));
vi.mock("@/db", () => ({ db: testDb.db }));
vi.mock("@/db/runBatch", () => ({ runBatch: testDb.runBatch }));
vi.mock("@/server/lib/runtime-env", () => ({
  getOptionalEnvValue: async (name: string) =>
    name === "AUTOGEO_QUEUE_MASTER_KEY_B64"
      ? btoa("k".repeat(32))
      : "dataforseo-key",
  isHostedServerAuthMode: hosted,
}));
vi.mock("@/server/billing/subscription", () => ({
  getOrCreateOrganizationCustomer: async () => ({ id: "organization" }),
  getUsageCreditsRemaining: async () => ({
    monthlyRemaining: 0,
    topupRemaining: 0,
  }),
}));
vi.mock("@/server/email/onboarding-drip", () => ({
  sendCreditsExhaustedEvent: vi.fn(),
}));
vi.mock("./aiVisibilityRetention", () => ({ pruneAiVisibility: vi.fn() }));

const due = "2026-09-01T06:00:00.000Z";
async function dueTracker(
  projectId: string,
  paused: boolean,
  schedule: {
    scheduleInterval?: "daily" | "weekly" | "monthly";
    nextCheckAt?: string;
    scheduleWeekday?: number | null;
    scheduleHour?: number | null;
    scheduleMinute?: number | null;
    scheduleTimeZone?: string | null;
  } = {},
) {
  const rows = configuration(
    { engines: ["chatgpt"], prompts: [{ text: "Which SEO tools?" }] },
    projectId,
  );
  await repo.saveConfiguration(rows);
  await repo.updateTracker(rows.tracker.id, {
    enabled: true,
    nextCheckAt: due,
    ...schedule,
  });
  if (paused) {
    const current = await repo.getConfiguration(projectId);
    if (!current) throw new Error("test tracker configuration was not created");
    await repo.saveConfiguration({
      ...current,
      prompts: current.prompts.map((prompt) => ({ ...prompt, paused: true })),
    });
  }
}

beforeEach(async () => {
  hosted.mockResolvedValue(false);
  await testDb.seedProject();
  await testDb.db.insert(projects).values({
    id: "paused-project",
    organizationId: "organization",
    name: "Paused",
    domain: "paused.example",
  });
});

afterEach(() => vi.useRealTimers());

it("moves every due tracker on, including one whose check cannot start", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-01T06:01:00.000Z"));
  await dueTracker("paused-project", true);
  await dueTracker("project", false);

  await runScheduledAiVisibility();

  const skipped = await repo.getTracker("paused-project");
  expect(skipped?.enabled).toBe(false);
  expect(skipped?.nextCheckAt).not.toBe(due);
  expect(skipped?.lastSkipReason).toMatch(/unpause prompts/);
  expect((await repo.getTracker("project"))?.nextCheckAt).not.toBe(due);
  expect(await repo.listRuns("project")).toMatchObject([
    { trigger: "scheduled", status: "queued" },
  ]);
});

it("records a skipped check for credits on the tracker without starting it", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-01T06:01:00.000Z"));
  hosted.mockResolvedValue(true);
  await dueTracker("project", false);

  await runScheduledAiVisibility();

  expect((await repo.getTracker("project"))?.lastSkipReason).toBe(
    "INSUFFICIENT_CREDITS",
  );
  expect(await repo.listRuns("project")).toEqual([]);
});

it("resumes the same scheduled run after the cron stops after its durable claim", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-01T06:01:00.000Z"));
  await dueTracker("project", false);
  const config = await repo.getConfiguration("project");
  if (!config) throw new Error("test tracker configuration was not created");
  const runId = "scheduled-outbox-recovery";
  const prompt = config.prompts[0];
  if (!prompt) throw new Error("test prompt was not created");
  await repo.createRun(
    {
      id: runId,
      trackerId: config.tracker.id,
      projectId: config.tracker.projectId,
      trigger: "scheduled",
      locationCode: config.tracker.locationCode,
      languageCode: config.tracker.languageCode,
      createdAt: new Date().toISOString(),
    },
    [
      {
        id: "scheduled-outbox-recovery-answer",
        runId,
        promptId: prompt.id,
        engine: "chatgpt",
        branded: false,
      },
    ],
  );
  await repo.updateTracker(config.tracker.id, {
    nextCheckAt: "2026-09-08T06:00:00.000Z",
    pendingScheduledRunId: runId,
  });

  await runScheduledAiVisibility();

  expect(await repo.listRuns("project")).toMatchObject([
    { id: runId, trigger: "scheduled", status: "queued" },
  ]);
  expect(workflow.create).toHaveBeenCalledTimes(1);
  expect(workflow.create.mock.calls[0]?.[0]).toMatchObject({ id: runId });
  expect((await repo.getTracker("project"))?.pendingScheduledRunId).toBeNull();
});

it("does not resume a queued scheduled run after the tracker was paused", async () => {
  workflow.create.mockClear();
  await dueTracker("project", false);
  const config = await repo.getConfiguration("project");
  if (!config) throw new Error("test tracker configuration was not created");
  const prompt = config.prompts[0];
  if (!prompt) throw new Error("test prompt was not created");
  const runId = "scheduled-outbox-paused";
  await repo.createRun(
    {
      id: runId,
      trackerId: config.tracker.id,
      projectId: "project",
      trigger: "scheduled",
      locationCode: config.tracker.locationCode,
      languageCode: config.tracker.languageCode,
      createdAt: new Date().toISOString(),
    },
    [
      {
        id: `${runId}-answer`,
        runId,
        promptId: prompt.id,
        engine: "chatgpt",
        branded: false,
      },
    ],
  );
  await repo.updateTracker(config.tracker.id, {
    pendingScheduledRunId: runId,
  });
  // Simulate a pause racing the scheduler after the run was claimed.
  await testDb.db
    .update(aiTrackers)
    .set({ enabled: false })
    .where(eq(aiTrackers.id, config.tracker.id));

  await runScheduledAiVisibility();

  expect(workflow.create).not.toHaveBeenCalled();
  expect(await repo.getRunInternal(runId)).toMatchObject({ status: "failed" });
  expect(await repo.getTracker("project")).toMatchObject({
    enabled: false,
    pendingScheduledRunId: null,
  });
});

it("cancels a queued scheduled outbox when its project was archived", async () => {
  workflow.create.mockClear();
  await dueTracker("project", false);
  const config = await repo.getConfiguration("project");
  if (!config) throw new Error("test tracker configuration was not created");
  const prompt = config.prompts[0];
  if (!prompt) throw new Error("test prompt was not created");
  const runId = "scheduled-outbox-archived-project";
  await repo.createRun(
    {
      id: runId,
      trackerId: config.tracker.id,
      projectId: "project",
      trigger: "scheduled",
      status: "queued",
      locationCode: config.tracker.locationCode,
      languageCode: config.tracker.languageCode,
      createdAt: new Date().toISOString(),
    },
    [
      {
        id: `${runId}-answer`,
        runId,
        promptId: prompt.id,
        engine: "chatgpt",
        branded: false,
      },
    ],
  );
  await repo.updateTracker(config.tracker.id, {
    pendingScheduledRunId: runId,
  });
  await testDb.db
    .update(projects)
    .set({ archivedAt: "2026-09-01T06:00:00.000Z" })
    .where(eq(projects.id, "project"));

  await runScheduledAiVisibility();

  expect(workflow.create).not.toHaveBeenCalled();
  expect(await repo.getRunInternal(runId)).toMatchObject({ status: "failed" });
  expect(await repo.getObservations([runId])).toMatchObject([
    {
      status: "failed",
      error: "The scheduled check was canceled because its project was archived before the queued check started.",
    },
  ]);
  expect(await repo.getTracker("project")).toMatchObject({
    pendingScheduledRunId: null,
    lastSkipReason:
      "The scheduled check was canceled because its project was archived before the queued check started.",
  });
});

it("does not resume a queued scheduled run after its prompt scope is removed", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-01T06:01:00.000Z"));
  workflow.create.mockClear();
  await dueTracker("project", false);
  const config = await repo.getConfiguration("project");
  if (!config) throw new Error("test tracker configuration was not created");
  const prompt = config.prompts[0];
  if (!prompt) throw new Error("test prompt was not created");
  const runId = "scheduled-outbox-scope-removed";
  await repo.createRun(
    {
      id: runId,
      trackerId: config.tracker.id,
      projectId: "project",
      trigger: "scheduled",
      locationCode: config.tracker.locationCode,
      languageCode: config.tracker.languageCode,
      createdAt: new Date().toISOString(),
    },
    [
      {
        id: `${runId}-answer`,
        runId,
        promptId: prompt.id,
        engine: "chatgpt",
        branded: false,
      },
    ],
  );
  await repo.updateTracker(config.tracker.id, {
    pendingScheduledRunId: runId,
    nextCheckAt: "2026-09-08T06:00:00.000Z",
  });
  // Simulate a scope removal racing the scheduler after the run was claimed.
  await testDb.db
    .update(aiPrompts)
    .set({ paused: true })
    .where(eq(aiPrompts.id, prompt.id));

  await runScheduledAiVisibility();

  expect(workflow.create).not.toHaveBeenCalled();
  expect(await repo.getRunInternal(runId)).toMatchObject({ status: "failed" });
  const tracker = await repo.getTracker("project");
  expect(tracker).toMatchObject({
    enabled: true,
    pendingScheduledRunId: null,
  });
  expect(tracker?.lastSkipReason).toMatch(/no longer has active prompts/);
});

it("retains a visible outbox claim when workflow creation cannot be confirmed", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-01T06:01:00.000Z"));
  workflow.create.mockRejectedValue(new Error("workflow endpoint unavailable"));
  workflow.get.mockRejectedValue(new Error("workflow lookup unavailable"));
  await dueTracker("project", false);

  const firstTick = runScheduledAiVisibility();
  await vi.advanceTimersByTimeAsync(2_500);
  await firstTick;

  const queued = await repo.listRuns("project");
  expect(queued).toMatchObject([{ trigger: "scheduled", status: "queued" }]);
  const latestRun = queued[0];
  if (!latestRun) throw new Error("scheduled run was not persisted");
  const runId = latestRun.id;
  const tracker = await repo.getTracker("project");
  expect(tracker?.pendingScheduledRunId).toBe(runId);
  expect(tracker?.lastSkipReason).toContain(
    "durably queued and will be retried automatically",
  );

  workflow.create.mockReset().mockResolvedValue(undefined);
  workflow.get.mockReset().mockResolvedValue({
    status: async () => ({ status: "queued" }),
  });
  await runScheduledAiVisibility();

  expect(await repo.listRuns("project")).toHaveLength(1);
  expect(workflow.create.mock.calls.at(-1)?.[0]).toMatchObject({ id: runId });
  expect((await repo.getTracker("project"))?.pendingScheduledRunId).toBeNull();
  expect((await repo.getTracker("project"))?.lastSkipReason).toBeNull();
});

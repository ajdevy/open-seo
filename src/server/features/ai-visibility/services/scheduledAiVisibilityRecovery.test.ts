import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  aiProviderRunBudgetLocks,
  aiProviderRunReservations,
  projects,
} from "@/db/schema";
import { AiVisibilityRepository as repo } from "../repositories/AiVisibilityRepository";
import { aiCostForAnswers } from "./aiVisibilityCost";
import { configuration } from "./aiVisibilityTestFixtures";
import { resumePendingScheduledRuns } from "./aiVisibilityScheduledRuns";
import { runScheduledAiVisibility } from "./scheduledAiVisibility";

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
vi.mock("@/db/runBatch", () => testDb.runBatchModule);
vi.mock("@/server/lib/runtime-env", () => ({
  getOptionalEnvValue: async (name: string) =>
    name === "AUTOGEO_QUEUE_MASTER_KEY_B64"
      ? btoa("k".repeat(32))
      : "dataforseo-key",
  isHostedServerAuthMode: hosted,
}));
vi.mock("@/server/lib/provider-access", () => ({
  hasDataforseoAccess: async () => true,
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

async function dueTracker() {
  const rows = configuration(
    { engines: ["chatgpt"], prompts: [{ text: "Which SEO tools?" }] },
    "project",
  );
  await repo.saveConfiguration(rows);
  await repo.updateTracker(rows.tracker.id, {
    enabled: true,
    nextCheckAt: due,
  });
}

async function persistPendingScheduledRun(
  runId: string,
  projectId = "project",
  createdAt = new Date().toISOString(),
) {
  let config = await repo.getConfiguration(projectId);
  if (!config) {
    await repo.saveConfiguration(
      configuration(
        { engines: ["chatgpt"], prompts: [{ text: "Which SEO tools?" }] },
        projectId,
      ),
    );
    config = await repo.getConfiguration(projectId);
  }
  if (!config) throw new Error("test tracker configuration was not created");
  if (!config.tracker.enabled)
    await repo.updateTracker(config.tracker.id, {
      enabled: true,
      nextCheckAt: due,
    });
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
      createdAt,
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
    nextCheckAt: "2026-09-08T06:00:00.000Z",
    pendingScheduledRunId: runId,
  });
  return config;
}

beforeEach(async () => {
  hosted.mockResolvedValue(false);
  workflow.create.mockResolvedValue(undefined);
  workflow.get.mockResolvedValue({
    status: async () => ({ status: "queued" }),
  });
  await testDb.seedProject();
});

afterEach(() => vi.useRealTimers());

it("resumes the same scheduled run after the cron stops after its durable claim", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-01T06:01:00.000Z"));
  await dueTracker();
  const runId = "scheduled-outbox-recovery";
  await persistPendingScheduledRun(runId);
  workflow.get.mockRejectedValue(new Error("workflow instance not found"));

  await runScheduledAiVisibility();

  expect(await repo.listRuns("project")).toMatchObject([
    { id: runId, trigger: "scheduled", status: "queued" },
  ]);
  expect(workflow.create).toHaveBeenCalledTimes(1);
  expect(workflow.create.mock.calls[0]?.[0]).toMatchObject({ id: runId });
  expect(
    await testDb.db.select().from(aiProviderRunReservations),
  ).toMatchObject([{ runId, status: "reserved" }]);
  expect((await repo.getTracker("project"))?.pendingScheduledRunId).toBeNull();
});

it("reuses the provider hold after a crash between reserve and workflow start", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-01T06:01:00.000Z"));
  await dueTracker();
  const runId = "scheduled-outbox-reservation-recovery";
  const config = await persistPendingScheduledRun(runId);
  const reservationCost = aiCostForAnswers(
    ["chatgpt"],
    false,
    "queued",
  ).providerCostUsd;
  await testDb.db.insert(aiProviderRunReservations).values({
    id: "scheduled-outbox-reservation",
    projectId: config.tracker.projectId,
    runId,
    reservedUsdMicros: Math.round(reservationCost * 1e6),
    status: "reserved",
    createdAt: new Date().toISOString(),
  });
  workflow.get.mockRejectedValue(new Error("workflow instance not found"));

  await runScheduledAiVisibility();

  expect(workflow.create).toHaveBeenCalledTimes(1);
  expect(workflow.create.mock.calls[0]?.[0]).toMatchObject({ id: runId });
  expect(
    await testDb.db.select().from(aiProviderRunReservations),
  ).toMatchObject([{ runId, status: "reserved" }]);
  expect((await repo.getTracker("project"))?.pendingScheduledRunId).toBeNull();
});

it("defers a concurrent recovery without failing or clearing its shared hold", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-01T06:01:00.000Z"));
  await dueTracker();
  const runId = "scheduled-outbox-concurrent-recovery";
  const createdAt = "2026-09-01T05:00:00.000Z";
  await persistPendingScheduledRun(runId, "project", createdAt);
  const reservationCost = aiCostForAnswers(
    ["chatgpt"],
    false,
    "queued",
  ).providerCostUsd;
  const reserveUsdMicros = Math.round(reservationCost * 1e6);
  await testDb.db
    .insert(aiProviderRunBudgetLocks)
    .values({ id: "provider-run-budget", version: 1 })
    .onConflictDoNothing();
  await testDb.client.execute(`
    CREATE TRIGGER insert_concurrent_scheduled_recovery_hold
    AFTER UPDATE ON ai_provider_run_budget_locks
    WHEN NEW.id = 'provider-run-budget'
    BEGIN
      INSERT INTO ai_provider_run_reservations (
        id, project_id, run_id, reserved_usd_micros, status, created_at
      ) VALUES (
        'scheduled-outbox-concurrent-owner', 'project', '${runId}',
        ${reserveUsdMicros}, 'reserved', '${createdAt}'
      );
    END;
  `);
  workflow.get.mockRejectedValue(new Error("workflow instance not found"));

  const deferred = await resumePendingScheduledRuns({
    answerBudget: 1,
    deadline: Date.now() + 60_000,
  });

  expect(deferred).toEqual({ started: 0, answersStarted: 0 });
  expect(workflow.create).not.toHaveBeenCalled();
  expect(await repo.listRuns("project")).toMatchObject([
    { id: runId, trigger: "scheduled", status: "queued" },
  ]);
  expect(
    await testDb.db.select().from(aiProviderRunReservations),
  ).toMatchObject([{ runId, status: "reserved" }]);
  expect((await repo.getTracker("project"))?.pendingScheduledRunId).toBe(runId);
  expect((await repo.getTracker("project"))?.lastSkipReason).toContain(
    "Another scheduled recovery currently owns the provider-budget reservation",
  );

  await testDb.client.execute(
    "DROP TRIGGER insert_concurrent_scheduled_recovery_hold",
  );
  const recovered = await resumePendingScheduledRuns({
    answerBudget: 1,
    deadline: Date.now() + 60_000,
  });

  expect(recovered).toEqual({ started: 1, answersStarted: 1 });
  expect(workflow.create).toHaveBeenCalledTimes(1);
  expect(workflow.create.mock.calls[0]?.[0]).toMatchObject({ id: runId });
  expect(
    await testDb.db.select().from(aiProviderRunReservations),
  ).toMatchObject([{ runId, status: "reserved" }]);
  expect((await repo.getTracker("project"))?.pendingScheduledRunId).toBeNull();
});

it("does not duplicate a workflow when retry lookup confirms it started", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-01T06:01:00.000Z"));
  workflow.create.mockRejectedValue(new Error("workflow endpoint unavailable"));
  workflow.get.mockRejectedValue(new Error("workflow lookup unavailable"));
  await dueTracker();

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
  expect(workflow.create).not.toHaveBeenCalled();
  expect(
    await testDb.db.select().from(aiProviderRunReservations),
  ).toMatchObject([{ runId, status: "reserved" }]);
  expect((await repo.getTracker("project"))?.pendingScheduledRunId).toBeNull();
  expect((await repo.getTracker("project"))?.lastSkipReason).toBeNull();
});

it("keeps recovered starts within the cron answer budget", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-01T06:01:00.000Z"));
  await dueTracker();
  await testDb.db.insert(projects).values({
    id: "second-project",
    organizationId: "organization",
    name: "Second project",
    domain: "second.example",
  });
  const firstRunId = "scheduled-budget-first";
  const secondRunId = "scheduled-budget-second";
  await persistPendingScheduledRun(
    firstRunId,
    "project",
    "2026-09-01T05:00:00.000Z",
  );
  await persistPendingScheduledRun(
    secondRunId,
    "second-project",
    "2026-09-01T05:01:00.000Z",
  );
  workflow.get.mockRejectedValue(new Error("workflow instance not found"));

  const result = await resumePendingScheduledRuns({
    answerBudget: 1,
    deadline: Date.now() + 60_000,
  });

  expect(result).toEqual({ started: 1, answersStarted: 1 });
  expect(workflow.create).toHaveBeenCalledTimes(1);
  expect(workflow.create.mock.calls[0]?.[0]).toMatchObject({ id: firstRunId });
  expect((await repo.getTracker("project"))?.pendingScheduledRunId).toBeNull();
  expect((await repo.getTracker("second-project"))?.pendingScheduledRunId).toBe(
    secondRunId,
  );
});

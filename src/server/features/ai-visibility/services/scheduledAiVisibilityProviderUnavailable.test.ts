import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { projects } from "@/db/schema";
import { AiVisibilityRepository as repo } from "../repositories/AiVisibilityRepository";
import { runScheduledAiVisibility } from "./scheduledAiVisibility";
import { configuration } from "./aiVisibilityTestFixtures";

const { testDb, workflow, hosted, providerAccess } = await vi.hoisted(
  async () => {
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
      providerAccess: vi.fn(),
    };
  },
);
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
  hasDataforseoAccess: providerAccess,
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
  providerAccess.mockResolvedValue(true);
  await testDb.seedProject();
  await testDb.db.insert(projects).values({
    id: "paused-project",
    organizationId: "organization",
    name: "Paused",
    domain: "paused.example",
  });
});

afterEach(() => vi.useRealTimers());

it("pauses tracking and cancels a queued run when provider access is lost during recovery", async () => {
  workflow.get.mockRejectedValue(new Error("workflow instance not found"));
  await dueTracker("project", false);
  const config = await repo.getConfiguration("project");
  if (!config) throw new Error("test tracker configuration was not created");
  const prompt = config.prompts[0];
  if (!prompt) throw new Error("test prompt was not created");
  const runId = "scheduled-outbox-provider-unavailable";
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
  providerAccess.mockResolvedValue(false);

  await runScheduledAiVisibility();

  expect(workflow.create).not.toHaveBeenCalled();
  expect(await repo.getRunInternal(runId)).toMatchObject({ status: "failed" });
  expect(await repo.getTracker("project")).toMatchObject({
    enabled: false,
    pendingScheduledRunId: null,
    lastSkipReason:
      "The configured provider is unavailable; the queued check was not started.",
  });
});

it("pauses tracking and cancels the claimed run when provider access disappears before dispatch", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-01T06:01:00.000Z"));
  await dueTracker("project", false);
  providerAccess.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

  await runScheduledAiVisibility();

  expect(workflow.create).not.toHaveBeenCalled();
  expect(await repo.listRuns("project")).toMatchObject([
    { trigger: "scheduled", status: "failed" },
  ]);
  expect(await repo.getTracker("project")).toMatchObject({
    enabled: false,
    pendingScheduledRunId: null,
    lastSkipReason:
      "The configured provider is unavailable; the queued check was not started.",
  });
});

it("clears an unavailable-provider pointer after confirming its workflow is already running", async () => {
  workflow.create.mockClear();
  await dueTracker("project", false);
  const config = await repo.getConfiguration("project");
  if (!config) throw new Error("test tracker configuration was not created");
  const prompt = config.prompts[0];
  if (!prompt) throw new Error("test prompt was not created");
  const runId = "scheduled-running-provider-unavailable";
  await repo.createRun(
    {
      id: runId,
      trackerId: config.tracker.id,
      projectId: config.tracker.projectId,
      trigger: "scheduled",
      status: "running",
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
  providerAccess.mockResolvedValue(false);
  workflow.get.mockResolvedValue({
    status: async () => ({ status: "running" }),
  });

  await runScheduledAiVisibility();

  expect(workflow.create).not.toHaveBeenCalled();
  expect(await repo.getRunInternal(runId)).toMatchObject({ status: "running" });
  expect(await repo.getTracker("project")).toMatchObject({
    enabled: false,
    pendingScheduledRunId: null,
    lastSkipReason:
      "The configured provider is unavailable; the queued check was not started.",
  });
});

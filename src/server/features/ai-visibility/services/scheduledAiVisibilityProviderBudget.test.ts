import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { aiProviderRunReservations } from "@/db/schema";
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
  engines: ("chatgpt" | "gemini" | "google_ai_overview")[] = ["chatgpt"],
) {
  const rows = configuration(
    { engines: [...engines], prompts: [{ text: "Which SEO tools?" }] },
    "project",
  );
  await repo.saveConfiguration(rows);
  await repo.updateTracker(rows.tracker.id, {
    enabled: true,
    nextCheckAt: due,
  });
  return rows;
}

beforeEach(async () => {
  hosted.mockResolvedValue(false);
  providerAccess.mockResolvedValue(true);
  workflow.create.mockReset().mockResolvedValue(undefined);
  workflow.get
    .mockReset()
    .mockRejectedValue(new Error("workflow instance not found"));
  await testDb.seedProject();
});

afterEach(() => vi.useRealTimers());

it("skips a scheduled run when its project rolling provider budget is exhausted", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-01T06:01:00.000Z"));
  const config = await dueTracker([
    "chatgpt",
    "gemini",
    "google_ai_overview",
  ]);
  await repo.updateTracker(config.tracker.id, { weeklyProviderBudgetCents: 1 });

  await runScheduledAiVisibility();

  expect((await repo.getTracker("project"))?.lastSkipReason).toContain(
    "rolling 7-day budget",
  );
  expect(await repo.listRuns("project")).toMatchObject([
    { trigger: "scheduled", status: "failed" },
  ]);
  expect(workflow.create).not.toHaveBeenCalled();
});

it("rejects a scheduled run prepared from an older project budget", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-01T06:01:00.000Z"));
  const original = await dueTracker();
  const staleBudgetCents = original.tracker.weeklyProviderBudgetCents;
  await repo.updateTracker(original.tracker.id, {
    weeklyProviderBudgetCents: 50,
  });

  const getConfiguration = repo.getConfiguration.bind(repo);
  let reads = 0;
  vi.spyOn(repo, "getConfiguration").mockImplementation(async (projectId) => {
    const current = await getConfiguration(projectId);
    if (!current) return current;
    reads++;
    return reads === 1
      ? {
          ...current,
          tracker: {
            ...current.tracker,
            weeklyProviderBudgetCents: staleBudgetCents,
          },
        }
      : current;
  });

  await runScheduledAiVisibility();

  expect(reads).toBe(2);
  expect(workflow.create).not.toHaveBeenCalled();
  expect(await repo.listRuns("project")).toMatchObject([
    { trigger: "scheduled", status: "failed" },
  ]);
  expect((await repo.getTracker("project"))?.lastSkipReason).toContain(
    "saved project provider budget no longer matches",
  );
  await expect(testDb.db.select().from(aiProviderRunReservations)).resolves.toEqual(
    [],
  );
});

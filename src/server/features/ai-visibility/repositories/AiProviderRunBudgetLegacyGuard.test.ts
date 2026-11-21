import { beforeEach, expect, it, vi } from "vitest";
import { aiProviderRunReservations, aiRuns } from "@/db/schema";
import { AiVisibilityRepository as repo } from "./AiVisibilityRepository";
import {
  getAiProviderBudgetUsage,
  getAiProviderGlobalBudgetUsage,
  reserveAiProviderRunBudget,
} from "./AiProviderRunBudgetRepository";
import { configuration } from "../services/aiVisibilityTestFixtures";

const { testDb } = await vi.hoisted(async () => {
  const { createAiVisibilityTestDb } = await import("../aiVisibilityTestDb");
  return { testDb: await createAiVisibilityTestDb() };
});
vi.mock("@/db", () => ({ db: testDb.db }));
vi.mock("@/db/runBatch", () => testDb.runBatchModule);
vi.mock("cloudflare:workers", () => ({ env: { DATABASE_PROVIDER: "d1" } }));

const projectId = "project";
const now = new Date("2026-11-20T12:00:00.000Z");
let trackerId: string;

beforeEach(async () => {
  await testDb.seedProject();
  const config = configuration({
    engines: ["chatgpt"],
    prompts: [{ text: "Which SEO tools?" }],
  });
  trackerId = config.tracker.id;
  await repo.saveConfiguration(config);
});

it("blocks admissions for one rolling window after an untracked terminal run", async () => {
  const recentLegacyRun = new Date(
    now.getTime() - 6 * 24 * 60 * 60_000,
  ).toISOString();
  await testDb.db.insert(aiRuns).values([
    {
      id: "legacy-terminal-run",
      trackerId,
      projectId,
      trigger: "manual",
      status: "completed",
      locationCode: 2840,
      languageCode: "en",
      createdAt: recentLegacyRun,
      completedAt: recentLegacyRun,
    },
    {
      id: "new-run",
      trackerId,
      projectId,
      trigger: "manual",
      status: "running",
      locationCode: 2840,
      languageCode: "en",
      createdAt: now.toISOString(),
      completedAt: null,
    },
  ]);
  await testDb.db.insert(aiProviderRunReservations).values({
    id: "legacy-terminal-spend-guard",
    projectId,
    runId: "legacy-terminal-run",
    reservedUsdMicros: 8_000_000,
    status: "legacy_guard",
    createdAt: now.toISOString(),
    reconciliationReference: "migration:legacy-terminal-spend-window",
  });

  await expect(
    getAiProviderBudgetUsage(projectId, now.getTime()),
  ).resolves.toEqual({
    accountedUsdMicros: 0,
    heldUsdMicros: 8_000_000,
  });
  await expect(getAiProviderGlobalBudgetUsage(now.getTime())).resolves.toEqual({
    accountedUsdMicros: 0,
    heldUsdMicros: 8_000_000,
  });
  await expect(
    reserveAiProviderRunBudget(
      {
        id: "reservation-new-run",
        projectId,
        runId: "new-run",
        limitUsdCents: 800,
        reserveUsdMicros: 1_000_000,
        createdAt: now.toISOString(),
      },
      now.getTime(),
    ),
  ).resolves.toMatchObject({
    admitted: false,
    reason: "budget_exceeded",
    remainingUsdMicros: 0,
  });

  const afterLegacyWindow = now.getTime() + 7 * 24 * 60 * 60_000 + 1;
  await expect(
    getAiProviderGlobalBudgetUsage(afterLegacyWindow),
  ).resolves.toEqual({ accountedUsdMicros: 0, heldUsdMicros: 0 });
  await expect(
    reserveAiProviderRunBudget(
      {
        id: "reservation-new-run-after-window",
        projectId,
        runId: "new-run",
        limitUsdCents: 800,
        reserveUsdMicros: 1_000_000,
        createdAt: now.toISOString(),
      },
      afterLegacyWindow,
    ),
  ).resolves.toMatchObject({ admitted: true });
});

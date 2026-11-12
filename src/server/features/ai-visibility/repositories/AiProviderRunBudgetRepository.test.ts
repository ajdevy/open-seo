import { beforeEach, describe, expect, it, vi } from "vitest";
import { aiProviderRunReservations, aiRuns } from "@/db/schema";
import { AiVisibilityRepository as repo } from "./AiVisibilityRepository";
import {
  getAiProviderBudgetUsage,
  markAiProviderRunBudgetUnknown,
  reserveAiProviderRunBudget,
  settleAiProviderRunBudget,
} from "./AiProviderRunBudgetRepository";
import { pruneAiHistory } from "./aiVisibilityRetentionRepository";
import { configuration } from "../services/aiVisibilityTestFixtures";

const { testDb } = await vi.hoisted(async () => {
  const { createAiVisibilityTestDb } = await import("../aiVisibilityTestDb");
  return { testDb: await createAiVisibilityTestDb() };
});
vi.mock("@/db", () => ({ db: testDb.db }));
vi.mock("@/db/runBatch", () => ({ runBatch: testDb.runBatch }));
vi.mock("cloudflare:workers", () => ({ env: { DATABASE_PROVIDER: "d1" } }));

const projectId = "project";
const now = new Date("2026-11-12T12:00:00.000Z");
let trackerId: string;

async function createRun(id: string, createdAt = now.toISOString()) {
  await testDb.db.insert(aiRuns).values({
    id,
    trackerId,
    projectId,
    trigger: "manual",
    status: "completed",
    locationCode: 2840,
    languageCode: "en",
    createdAt,
    completedAt: createdAt,
  });
}

async function reserve(runId: string, reserveUsdMicros: number) {
  return reserveAiProviderRunBudget({
    id: `reservation-${runId}`,
    projectId,
    runId,
    limitUsdCents: 800,
    reserveUsdMicros,
    createdAt: now.toISOString(),
  });
}

beforeEach(async () => {
  await testDb.seedProject();
  const config = configuration({
    engines: ["chatgpt"],
    prompts: [{ text: "Which SEO tools?" }],
  });
  trackerId = config.tracker.id;
  await repo.saveConfiguration(config);
});

describe("provider run budget reservations", () => {
  it("counts rolling settled usage and never expires an unresolved hold", async () => {
    const olderThanWindow = new Date(
      now.getTime() - 8 * 24 * 60 * 60_000,
    ).toISOString();
    const withinWindow = new Date(
      now.getTime() - 6 * 24 * 60 * 60_000,
    ).toISOString();
    const settledRecently = new Date(
      now.getTime() - 24 * 60 * 60_000,
    ).toISOString();
    await createRun("old-settled", olderThanWindow);
    await createRun("recent-settled", withinWindow);
    await createRun("settled-after-long-run", olderThanWindow);
    await createRun("old-unknown", olderThanWindow);
    await testDb.db.insert(aiProviderRunReservations).values([
      {
        id: "old-settled-reservation",
        projectId,
        runId: "old-settled",
        reservedUsdMicros: 2_000_000,
        accountedUsdMicros: 2_000_000,
        status: "settled",
        createdAt: olderThanWindow,
        settledAt: olderThanWindow,
      },
      {
        id: "recent-settled-reservation",
        projectId,
        runId: "recent-settled",
        reservedUsdMicros: 3_000_000,
        accountedUsdMicros: 3_000_000,
        status: "settled",
        createdAt: withinWindow,
        settledAt: withinWindow,
      },
      {
        id: "settled-after-long-run-reservation",
        projectId,
        runId: "settled-after-long-run",
        reservedUsdMicros: 1_500_000,
        accountedUsdMicros: 1_500_000,
        status: "settled",
        createdAt: olderThanWindow,
        settledAt: settledRecently,
      },
      {
        id: "old-unknown-reservation",
        projectId,
        runId: "old-unknown",
        reservedUsdMicros: 4_000_000,
        status: "unknown",
        createdAt: olderThanWindow,
      },
    ]);

    await expect(
      getAiProviderBudgetUsage(projectId, now.getTime()),
    ).resolves.toEqual({
      accountedUsdMicros: 4_500_000,
      heldUsdMicros: 4_000_000,
    });
  });

  it("admits within the rolling cap, serializes active runs, and keeps unknown spend held", async () => {
    await createRun("first");
    await createRun("second");
    await createRun("third");

    await expect(reserve("first", 5_500_000)).resolves.toMatchObject({
      admitted: true,
    });
    await expect(reserve("second", 2_000_000)).resolves.toMatchObject({
      admitted: false,
      reason: "run_in_progress",
    });

    await markAiProviderRunBudgetUnknown("first");
    await expect(reserve("second", 2_000_000)).resolves.toMatchObject({
      admitted: true,
      remainingUsdMicros: 500_000,
    });
    await expect(reserve("third", 1_000_000)).resolves.toMatchObject({
      admitted: false,
      reason: "budget_exceeded",
      remainingUsdMicros: 500_000,
    });

    await settleAiProviderRunBudget("second", now.toISOString());
    await expect(
      getAiProviderBudgetUsage(projectId, now.getTime()),
    ).resolves.toEqual({
      accountedUsdMicros: 2_000_000,
      heldUsdMicros: 5_500_000,
    });
  });

  it("prunes settled history without deleting unresolved provider reservations", async () => {
    const olderThanRetention = new Date(now);
    olderThanRetention.setUTCMonth(olderThanRetention.getUTCMonth() - 14);
    const oldDate = olderThanRetention.toISOString();
    await createRun("old-settled", oldDate);
    await createRun("old-unknown", oldDate);
    await createRun("old-free", oldDate);
    await testDb.db.insert(aiProviderRunReservations).values([
      {
        id: "old-settled-reservation",
        projectId,
        runId: "old-settled",
        reservedUsdMicros: 1_000_000,
        accountedUsdMicros: 1_000_000,
        status: "settled",
        createdAt: oldDate,
        settledAt: oldDate,
      },
      {
        id: "old-unknown-reservation",
        projectId,
        runId: "old-unknown",
        reservedUsdMicros: 2_000_000,
        status: "unknown",
        createdAt: oldDate,
      },
    ]);

    await pruneAiHistory(now);

    const remainingRuns = await testDb.db
      .select({ id: aiRuns.id })
      .from(aiRuns);
    const remainingReservations = await testDb.db
      .select({ runId: aiProviderRunReservations.runId })
      .from(aiProviderRunReservations);
    expect(remainingRuns).toEqual([{ id: "old-unknown" }]);
    expect(remainingReservations).toEqual([{ runId: "old-unknown" }]);
  });

  it("admits only one concurrent provider run for a project", async () => {
    await createRun("concurrent-first");
    await createRun("concurrent-second");

    const outcomes = await Promise.all([
      reserve("concurrent-first", 6_000_000),
      reserve("concurrent-second", 6_000_000),
    ]);

    expect(outcomes.filter((outcome) => outcome.admitted)).toHaveLength(1);
    expect(outcomes.filter((outcome) => !outcome.admitted)).toMatchObject([
      { admitted: false, reason: "run_in_progress" },
    ]);
    await expect(
      getAiProviderBudgetUsage(projectId, now.getTime()),
    ).resolves.toEqual({ accountedUsdMicros: 0, heldUsdMicros: 6_000_000 });
  });
});

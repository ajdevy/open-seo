import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { aiProviderRunReservations, aiRuns, aiTrackers } from "@/db/schema";
import { AiVisibilityRepository as repo } from "./AiVisibilityRepository";
import {
  getAiProviderGlobalBudgetUsage,
  markAiProviderRunBudgetUnknown,
  reserveAiProviderRunBudget,
} from "./AiProviderRunBudgetRepository";
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

async function createRun(id: string) {
  await testDb.db.insert(aiRuns).values({
    id,
    trackerId,
    projectId,
    trigger: "manual",
    status: "completed",
    locationCode: 2840,
    languageCode: "en",
    createdAt: now.toISOString(),
    completedAt: now.toISOString(),
  });
}

async function reserve(runId: string, limitUsdCents = 800) {
  return reserveAiProviderRunBudget({
    id: `reservation-${runId}`,
    projectId,
    runId,
    limitUsdCents,
    reserveUsdMicros: 6_000_000,
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

describe("provider run budget lifecycle", () => {
  it("keeps an existing reservation held when a retry no longer fits a lowered cap", async () => {
    await createRun("same-run");
    await expect(reserve("same-run")).resolves.toMatchObject({
      admitted: true,
    });

    await testDb.db
      .update(aiTrackers)
      .set({ weeklyProviderBudgetCents: 500 })
      .where(eq(aiTrackers.id, trackerId));
    await expect(reserve("same-run", 500)).resolves.toMatchObject({
      admitted: false,
      reason: "budget_exceeded",
    });

    const [reservation] = await testDb.db
      .select({ status: aiProviderRunReservations.status })
      .from(aiProviderRunReservations)
      .where(eq(aiProviderRunReservations.runId, "same-run"));
    expect(reservation?.status).toBe("reserved");

    await markAiProviderRunBudgetUnknown("same-run");
    await expect(
      getAiProviderGlobalBudgetUsage(now.getTime()),
    ).resolves.toEqual({ accountedUsdMicros: 0, heldUsdMicros: 6_000_000 });
  });

  it("retains unresolved spend when the owning run is deleted", async () => {
    await createRun("deleted-run");
    await reserve("deleted-run");
    await markAiProviderRunBudgetUnknown("deleted-run");

    await testDb.client.execute("DELETE FROM ai_runs WHERE id = 'deleted-run'");

    const [reservation] = await testDb.db
      .select({ status: aiProviderRunReservations.status })
      .from(aiProviderRunReservations)
      .where(eq(aiProviderRunReservations.runId, "deleted-run"));
    expect(reservation?.status).toBe("unknown");
    await expect(
      getAiProviderGlobalBudgetUsage(now.getTime()),
    ).resolves.toEqual({ accountedUsdMicros: 0, heldUsdMicros: 6_000_000 });
  });

  it("retains unresolved spend when the owning project is deleted", async () => {
    await createRun("deleted-project-run");
    await reserve("deleted-project-run");
    await markAiProviderRunBudgetUnknown("deleted-project-run");

    await testDb.client.execute("DELETE FROM projects WHERE id = 'project'");

    const [reservation] = await testDb.db
      .select({ status: aiProviderRunReservations.status })
      .from(aiProviderRunReservations)
      .where(eq(aiProviderRunReservations.runId, "deleted-project-run"));
    expect(reservation?.status).toBe("unknown");
    await expect(
      getAiProviderGlobalBudgetUsage(now.getTime()),
    ).resolves.toEqual({ accountedUsdMicros: 0, heldUsdMicros: 6_000_000 });
  });
});

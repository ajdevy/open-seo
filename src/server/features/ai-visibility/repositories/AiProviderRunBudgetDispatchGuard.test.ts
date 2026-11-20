import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { aiProviderRunReservations, aiRuns } from "@/db/schema";
import { AiVisibilityRepository as repo } from "./AiVisibilityRepository";
import { hasReservedAiProviderRunBudget } from "./AiProviderRunBudgetRepository";
import { configuration } from "../services/aiVisibilityTestFixtures";

const { testDb } = await vi.hoisted(async () => {
  const { createAiVisibilityTestDb } = await import("../aiVisibilityTestDb");
  return { testDb: await createAiVisibilityTestDb() };
});
vi.mock("@/db", () => ({ db: testDb.db }));
vi.mock("@/db/runBatch", () => ({ runBatch: testDb.runBatch }));
vi.mock("cloudflare:workers", () => ({ env: { DATABASE_PROVIDER: "d1" } }));

beforeEach(async () => {
  await testDb.seedProject();
  const config = configuration({
    engines: ["chatgpt"],
    prompts: [{ text: "Which SEO tools?" }],
  });
  await repo.saveConfiguration(config);
  await testDb.db.insert(aiRuns).values({
    id: "legacy-run",
    trackerId: config.tracker.id,
    projectId: "project",
    trigger: "manual",
    status: "running",
    locationCode: 2840,
    languageCode: "en",
    createdAt: "2026-11-20T12:00:00.000Z",
    completedAt: null,
  });
});

describe("provider budget dispatch guard", () => {
  it("allows dispatch only while a reservation is active", async () => {
    await expect(hasReservedAiProviderRunBudget("legacy-run")).resolves.toBe(
      false,
    );
    await testDb.db.insert(aiProviderRunReservations).values({
      id: "reservation",
      projectId: "project",
      runId: "legacy-run",
      reservedUsdMicros: 1_000_000,
      status: "reserved",
      createdAt: "2026-11-20T12:00:00.000Z",
    });
    await expect(hasReservedAiProviderRunBudget("legacy-run")).resolves.toBe(
      true,
    );

    await testDb.db
      .update(aiProviderRunReservations)
      .set({ status: "unknown" })
      .where(eq(aiProviderRunReservations.runId, "legacy-run"));
    await expect(hasReservedAiProviderRunBudget("legacy-run")).resolves.toBe(
      false,
    );
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { aiProviderRunReservations, aiRuns } from "@/db/schema";
import { AiVisibilityRepository as repo } from "./AiVisibilityRepository";
import {
  getAiProviderBudgetUsage,
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
vi.mock("@/server/lib/runtime-env", () => ({
  getOptionalEnvValue: async (name: string) =>
    name === "AUTOGEO_QUEUE_MASTER_KEY_B64" ? btoa("k".repeat(32)) : undefined,
}));

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

beforeEach(async () => {
  await testDb.seedProject();
  const config = configuration({
    engines: ["chatgpt"],
    prompts: [{ text: "Which SEO tools?" }],
  });
  trackerId = config.tracker.id;
  await repo.saveConfiguration(config);
});

describe("provider budget admission races", () => {
  it("rejects a reservation when its saved project budget snapshot is stale", async () => {
    await createRun("stale-budget-run");
    await repo.updateTracker(trackerId, { weeklyProviderBudgetCents: 50 });

    await expect(
      reserveAiProviderRunBudget({
        id: "reservation-stale-budget-run",
        projectId,
        runId: "stale-budget-run",
        limitUsdCents: 800,
        reserveUsdMicros: 2_000_000,
        createdAt: now.toISOString(),
      }),
    ).resolves.toMatchObject({
      admitted: false,
      reason: "budget_changed",
    });
    await expect(
      testDb.db.select().from(aiProviderRunReservations),
    ).resolves.toEqual([]);
  });

  it("does not resume an existing hold under a stale project budget snapshot", async () => {
    await createRun("held-stale-budget-run");
    await expect(
      reserveAiProviderRunBudget({
        id: "reservation-held-stale-budget-run",
        projectId,
        runId: "held-stale-budget-run",
        limitUsdCents: 800,
        reserveUsdMicros: 2_000_000,
        createdAt: now.toISOString(),
      }),
    ).resolves.toMatchObject({ admitted: true });
    await repo.updateTracker(trackerId, { weeklyProviderBudgetCents: 50 });

    await expect(
      reserveAiProviderRunBudget({
        id: "reservation-held-stale-budget-run-retry",
        projectId,
        runId: "held-stale-budget-run",
        limitUsdCents: 800,
        reserveUsdMicros: 2_000_000,
        createdAt: now.toISOString(),
      }),
    ).resolves.toMatchObject({
      admitted: false,
      reason: "budget_changed",
    });
    await expect(
      testDb.db
        .select({ status: aiProviderRunReservations.status })
        .from(aiProviderRunReservations),
    ).resolves.toEqual([{ status: "reserved" }]);
  });

  it("rechecks the rolling cap if an unresolved hold appears during admission", async () => {
    await createRun("racing-run");
    await createRun("racing-unknown");
    await testDb.client.execute(`
      CREATE TRIGGER add_unknown_hold_after_admission
      AFTER INSERT ON ai_provider_run_reservations
      WHEN NEW.run_id = 'racing-run'
      BEGIN
        INSERT INTO ai_provider_run_reservations (
          id, project_id, run_id, reserved_usd_micros, status, created_at
        ) VALUES (
          'racing-unknown-reservation', 'project', 'racing-unknown',
          5000000, 'unknown', '2026-11-12T12:00:00.000Z'
        );
      END;
    `);

    await expect(
      reserveAiProviderRunBudget({
        id: "reservation-racing-run",
        projectId,
        runId: "racing-run",
        limitUsdCents: 800,
        reserveUsdMicros: 4_000_000,
        createdAt: now.toISOString(),
      }),
    ).resolves.toMatchObject({
      admitted: false,
      reason: "budget_exceeded",
      usedUsdMicros: 5_000_000,
      remainingUsdMicros: 3_000_000,
    });
    const reservations = await testDb.db
      .select()
      .from(aiProviderRunReservations);
    expect(
      reservations.find((reservation) => reservation.runId === "racing-run")
        ?.status,
    ).toBe("released");
    await expect(
      getAiProviderBudgetUsage(projectId, now.getTime()),
    ).resolves.toEqual({ accountedUsdMicros: 0, heldUsdMicros: 5_000_000 });
  });
});

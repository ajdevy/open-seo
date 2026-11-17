import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { aiProviderRunReservations, aiRuns } from "@/db/schema";
import { AiVisibilityRepository as repo } from "./AiVisibilityRepository";
import {
  markAiProviderRunBudgetUnknown,
  reconcileAiProviderRunBudget,
  reserveAiProviderRunBudget,
} from "./AiProviderRunBudgetRepository";
import { getAiProviderBudgetUsage } from "./AiProviderRunBudgetRepository";
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

describe("provider run budget recovery", () => {
  it("settles an unknown hold at an evidenced amount and is idempotent", async () => {
    await createRun("unknown-settled");
    await reserve("unknown-settled", 4_000_000);
    await markAiProviderRunBudgetUnknown("unknown-settled");
    const reconciliation = {
      runId: "unknown-settled",
      outcome: "settled" as const,
      accountedUsdMicros: 1_250_000,
      settledAt: now.toISOString(),
      evidenceReference: "provider-usage:invoice-123",
      reconciledAt: now.toISOString(),
    };

    await expect(reconcileAiProviderRunBudget(reconciliation)).resolves.toEqual(
      { reconciled: true, status: "settled" },
    );
    await expect(reconcileAiProviderRunBudget(reconciliation)).resolves.toEqual(
      { reconciled: true, status: "settled" },
    );
    await expect(
      getAiProviderBudgetUsage(projectId, now.getTime()),
    ).resolves.toEqual({ accountedUsdMicros: 1_250_000, heldUsdMicros: 0 });
    const [reservation] = await testDb.db
      .select()
      .from(aiProviderRunReservations)
      .where(eq(aiProviderRunReservations.runId, "unknown-settled"));
    expect(reservation).toMatchObject({
      status: "settled",
      reservedUsdMicros: 4_000_000,
      accountedUsdMicros: 1_250_000,
      reconciliationReference: "provider-usage:invoice-123",
      reconciledAt: now.toISOString(),
    });
  });

  it("releases an unknown hold only from explicit zero-charge evidence", async () => {
    await createRun("unknown-released");
    await reserve("unknown-released", 4_000_000);
    await markAiProviderRunBudgetUnknown("unknown-released");

    await expect(
      reconcileAiProviderRunBudget({
        runId: "unknown-released",
        outcome: "released",
        evidenceReference: "provider-usage:no-charge-456",
        reconciledAt: now.toISOString(),
      }),
    ).resolves.toEqual({ reconciled: true, status: "released" });
    await expect(
      getAiProviderBudgetUsage(projectId, now.getTime()),
    ).resolves.toEqual({ accountedUsdMicros: 0, heldUsdMicros: 0 });
    const [reservation] = await testDb.db
      .select()
      .from(aiProviderRunReservations)
      .where(eq(aiProviderRunReservations.runId, "unknown-released"));
    expect(reservation).toMatchObject({
      status: "released",
      accountedUsdMicros: 0,
      settledAt: null,
      reconciliationReference: "provider-usage:no-charge-456",
    });
  });

  it("retains unknown holds unless the evidence and amount permit reconciliation", async () => {
    await createRun("unknown-stays-held");
    await reserve("unknown-stays-held", 4_000_000);
    await markAiProviderRunBudgetUnknown("unknown-stays-held");
    await expect(
      reconcileAiProviderRunBudget({
        runId: "unknown-stays-held",
        outcome: "settled",
        accountedUsdMicros: 4_000_001,
        settledAt: now.toISOString(),
        evidenceReference: "provider-usage:too-high",
      }),
    ).resolves.toEqual({
      reconciled: false,
      reason: "accounted_amount_exceeds_reservation",
    });
    await expect(
      reconcileAiProviderRunBudget({
        runId: "unknown-stays-held",
        outcome: "released",
        evidenceReference: "not a safe reference",
      }),
    ).rejects.toThrow("Provider budget evidence reference is invalid.");
    await expect(
      getAiProviderBudgetUsage(projectId, now.getTime()),
    ).resolves.toEqual({ accountedUsdMicros: 0, heldUsdMicros: 4_000_000 });

    await createRun("still-reserved");
    await reserve("still-reserved", 2_000_000);
    await expect(
      reconcileAiProviderRunBudget({
        runId: "still-reserved",
        outcome: "released",
        evidenceReference: "provider-usage:incorrect-state",
      }),
    ).resolves.toEqual({
      reconciled: false,
      reason: "reservation_not_unknown",
    });
  });
});

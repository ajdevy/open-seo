import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { aiProviderRunReservations, aiRuns } from "@/db/schema";
import { AiVisibilityRepository as repo } from "./AiVisibilityRepository";
import {
  AI_PROVIDER_RUN_SETTLEMENT_GRACE_MS,
  listUnknownAiProviderRunBudgets,
  markAiProviderRunBudgetUnknown,
  reconcileAiProviderRunBudget,
} from "./AiProviderRunBudgetRecoveryRepository";
import { reserveAiProviderRunBudget } from "./AiProviderRunBudgetRepository";
import { getAiProviderBudgetUsage } from "./AiProviderRunBudgetRepository";
import { configuration } from "../services/aiVisibilityTestFixtures";

const { testDb } = await vi.hoisted(async () => {
  const { createAiVisibilityTestDb } = await import("../aiVisibilityTestDb");
  return { testDb: await createAiVisibilityTestDb() };
});
vi.mock("@/db", () => ({ db: testDb.db }));
vi.mock("@/db/runBatch", () => testDb.runBatchModule);
vi.mock("cloudflare:workers", () => ({ env: { DATABASE_PROVIDER: "d1" } }));

const projectId = "project";
const now = new Date("2026-11-12T12:00:00.000Z");
let trackerId: string;

async function createRun(id: string, completedAt = now.toISOString()) {
  await testDb.db.insert(aiRuns).values({
    id,
    trackerId,
    projectId,
    trigger: "manual",
    status: "completed",
    locationCode: 2840,
    languageCode: "en",
    createdAt: completedAt,
    completedAt,
  });
}

async function reserve(runId: string, reserveUsdMicros: number) {
  return reserveAiProviderRunBudget(
    {
      id: `reservation-${runId}`,
      projectId,
      runId,
      limitUsdCents: 800,
      reserveUsdMicros,
      createdAt: now.toISOString(),
    },
    now.getTime(),
  );
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

  it("accounts evidenced charges above the estimate and keeps invalid evidence held", async () => {
    await createRun("unknown-stays-held");
    await reserve("unknown-stays-held", 4_000_000);
    await markAiProviderRunBudgetUnknown("unknown-stays-held");
    await expect(
      reconcileAiProviderRunBudget({
        runId: "unknown-stays-held",
        outcome: "settled",
        accountedUsdMicros: 4_000_001,
        settledAt: now.toISOString(),
        evidenceReference: "provider-usage:overrun",
      }),
    ).resolves.toEqual({ reconciled: true, status: "settled" });
    await expect(
      reconcileAiProviderRunBudget({
        runId: "unknown-stays-held",
        outcome: "released",
        evidenceReference: "not a safe reference",
      }),
    ).rejects.toThrow("Provider budget evidence reference is invalid.");
    await expect(
      getAiProviderBudgetUsage(projectId, now.getTime()),
    ).resolves.toEqual({ accountedUsdMicros: 4_000_001, heldUsdMicros: 0 });

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

  it("lists only bounded reservation metadata for operator reconciliation", async () => {
    await createRun("unknown-list-one");
    await createRun("unknown-list-two");
    await reserve("unknown-list-one", 4_000_000);
    await reserve("unknown-list-two", 2_000_000);
    await markAiProviderRunBudgetUnknown("unknown-list-one");
    await markAiProviderRunBudgetUnknown("unknown-list-two");

    const reservations = await listUnknownAiProviderRunBudgets(1);
    expect(reservations).toHaveLength(1);
    expect(reservations[0]).toMatchObject({
      projectId,
    });
    expect(["unknown-list-one", "unknown-list-two"]).toContain(
      reservations[0]?.runId,
    );
    expect(new Set(Object.keys(reservations[0]))).toEqual(
      new Set(["createdAt", "projectId", "reservedUsdMicros", "runId"]),
    );
    await expect(listUnknownAiProviderRunBudgets(0)).rejects.toThrow(
      "Provider budget queue limit is invalid.",
    );
  });

  it("quarantines a reserved hold after its run is deleted and lists it for reconciliation", async () => {
    await createRun("deleted-run-with-provider-hold");
    await reserve("deleted-run-with-provider-hold", 3_000_000);
    await testDb.db
      .delete(aiRuns)
      .where(eq(aiRuns.id, "deleted-run-with-provider-hold"));

    await expect(
      listUnknownAiProviderRunBudgets(100, now.getTime()),
    ).resolves.toEqual([
      {
        runId: "deleted-run-with-provider-hold",
        projectId,
        reservedUsdMicros: 3_000_000,
        createdAt: now.toISOString(),
      },
    ]);
    await expect(
      testDb.db
        .select({ status: aiProviderRunReservations.status })
        .from(aiProviderRunReservations)
        .where(
          eq(aiProviderRunReservations.runId, "deleted-run-with-provider-hold"),
        ),
    ).resolves.toEqual([{ status: "unknown" }]);
    await expect(
      getAiProviderBudgetUsage(projectId, now.getTime()),
    ).resolves.toEqual({ accountedUsdMicros: 0, heldUsdMicros: 3_000_000 });
    await expect(
      reconcileAiProviderRunBudget({
        runId: "deleted-run-with-provider-hold",
        outcome: "released",
        evidenceReference: "operator:verified-no-dispatch",
        reconciledAt: now.toISOString(),
      }),
    ).resolves.toEqual({ reconciled: true, status: "released" });
  });

  it("quarantines a terminal run whose provider settlement window has expired", async () => {
    const completedAt = new Date(
      now.getTime() - AI_PROVIDER_RUN_SETTLEMENT_GRACE_MS - 60_000,
    ).toISOString();
    await createRun("terminal-run-with-unsettled-provider-hold", completedAt);
    await testDb.db.insert(aiProviderRunReservations).values({
      id: "terminal-run-stuck-settlement",
      projectId,
      runId: "terminal-run-with-unsettled-provider-hold",
      reservedUsdMicros: 3_000_000,
      status: "reserved",
      createdAt: completedAt,
    });

    await expect(
      listUnknownAiProviderRunBudgets(100, now.getTime()),
    ).resolves.toEqual([
      {
        runId: "terminal-run-with-unsettled-provider-hold",
        projectId,
        reservedUsdMicros: 3_000_000,
        createdAt: completedAt,
      },
    ]);
    await expect(
      testDb.db
        .select({ status: aiProviderRunReservations.status })
        .from(aiProviderRunReservations)
        .where(
          eq(
            aiProviderRunReservations.runId,
            "terminal-run-with-unsettled-provider-hold",
          ),
        ),
    ).resolves.toEqual([{ status: "unknown" }]);
  });

  it("keeps terminal reservations during the late-answer settlement window", async () => {
    const completedAt = new Date(
      now.getTime() - AI_PROVIDER_RUN_SETTLEMENT_GRACE_MS + 60_000,
    ).toISOString();
    await createRun("terminal-run-still-reading-late-answers", completedAt);
    await testDb.db.insert(aiProviderRunReservations).values({
      id: "terminal-run-still-settling",
      projectId,
      runId: "terminal-run-still-reading-late-answers",
      reservedUsdMicros: 3_000_000,
      status: "reserved",
      createdAt: completedAt,
    });

    await expect(
      listUnknownAiProviderRunBudgets(100, now.getTime()),
    ).resolves.toEqual([]);
    await expect(
      testDb.db
        .select({ status: aiProviderRunReservations.status })
        .from(aiProviderRunReservations)
        .where(
          eq(
            aiProviderRunReservations.runId,
            "terminal-run-still-reading-late-answers",
          ),
        ),
    ).resolves.toEqual([{ status: "reserved" }]);
  });
});

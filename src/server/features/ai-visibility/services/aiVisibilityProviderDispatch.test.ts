import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectCompetitors } from "@/db/schema";
import { DataforseoDispatchNotStartedError } from "@/server/lib/dataforseo/envelope";
import { AppError } from "@/server/lib/errors";
import { AiVisibilityRepository as repo } from "../repositories/AiVisibilityRepository";
import { configuration, customer } from "./aiVisibilityTestFixtures";
import { collectAiLiveBatch, postAiBatch } from "./aiVisibilityCollection";

const { testDb, dataforseo } = await vi.hoisted(async () => {
  const { createAiVisibilityTestDb } = await import("../aiVisibilityTestDb");
  return {
    testDb: await createAiVisibilityTestDb(),
    dataforseo: {
      trackingTaskPost: vi.fn(),
      trackingLiveBatchWithCosts: vi.fn(),
      fetchTaskResult: vi.fn(),
    },
  };
});

vi.mock("cloudflare:workers", () => ({ env: { DATABASE_PROVIDER: "d1" } }));
vi.mock("cloudflare:workflows", () => ({
  NonRetryableError: class extends Error {},
}));
vi.mock("@/db", () => ({ db: testDb.db }));
vi.mock("@/db/runBatch", () => ({ runBatch: testDb.runBatch }));
vi.mock("@/server/lib/runtime-env", () => ({
  getOptionalEnvValue: async (name: string) =>
    name === "AUTOGEO_QUEUE_MASTER_KEY_B64" ? btoa("k".repeat(32)) : undefined,
  isHostedServerAuthMode: async () => false,
}));
vi.mock("@/server/lib/dataforseo", () => ({
  MAX_TASKS_PER_POST: 100,
  createDataforseoClient: () => ({
    aiSearch: {
      trackingTaskPost: dataforseo.trackingTaskPost,
      trackingLiveBatchWithCosts: dataforseo.trackingLiveBatchWithCosts,
    },
  }),
  fetchAiTrackingTaskResult: dataforseo.fetchTaskResult,
}));

const runId = "dispatch-run";
const market = { locationCode: 2840, languageCode: "en" };

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(async () => {
  await testDb.seedProject();
  await testDb.db.insert(projectCompetitors).values({
    id: "competitor",
    projectId: "project",
    domain: "ahrefs.com",
    name: "Ahrefs",
    updatedBy: "user",
  });
  const rows = configuration({
    engines: ["chatgpt"],
    prompts: [{ text: "Which SEO tools?" }],
  });
  await repo.saveConfiguration(rows);
  await repo.createRun(
    {
      id: runId,
      trackerId: rows.tracker.id,
      projectId: "project",
      trigger: "manual",
      status: "running",
      ...market,
      createdAt: "2026-09-05T12:00:00.000Z",
    },
    rows.prompts.map((prompt) => ({
      id: "answer-0",
      runId,
      promptId: prompt.id,
      engine: "chatgpt",
      branded: false,
    })),
  );
});

describe("provider dispatch certainty", () => {
  it("accounts a queued credit refusal as zero provider spend", async () => {
    dataforseo.trackingTaskPost.mockRejectedValue(
      new DataforseoDispatchNotStartedError(
        new AppError("INSUFFICIENT_CREDITS"),
      ),
    );

    const result = await postAiBatch(runId, customer, market, {
      engine: "chatgpt",
      tasks: [{ tag: "answer-0", prompt: "Which SEO tools?" }],
    });

    expect(result).toMatchObject({
      providerCostUsd: 0,
      providerCostKnown: true,
      providerCallMayHaveStarted: false,
    });
    expect(await repo.getObservation("answer-0")).toMatchObject({
      status: "failed",
      error: "INSUFFICIENT_CREDITS",
    });
  });

  it("keeps queued spend unknown when the response omits a submitted task", async () => {
    dataforseo.trackingTaskPost.mockResolvedValue({
      tasks: [],
      hold: null,
      providerCostUsd: 0,
      providerCostKnown: true,
    });

    const result = await postAiBatch(runId, customer, market, {
      engine: "chatgpt",
      tasks: [{ tag: "answer-0", prompt: "Which SEO tools?" }],
    });

    expect(result).toMatchObject({
      providerCostUsd: 0,
      providerCostKnown: false,
      providerCallMayHaveStarted: true,
    });
  });

  it("accounts a live credit refusal as zero provider spend", async () => {
    dataforseo.trackingLiveBatchWithCosts.mockResolvedValue([
      {
        status: "rejected",
        reason: new DataforseoDispatchNotStartedError(
          new AppError("INSUFFICIENT_CREDITS"),
        ),
      },
    ]);

    const result = await collectAiLiveBatch(runId, customer, market, [
      { tag: "answer-0", prompt: "Which SEO tools?", engine: "chatgpt" },
    ]);

    expect(result).toEqual({
      providerCostUsd: 0,
      providerCostKnown: true,
      providerCallMayHaveStarted: false,
    });
    expect(await repo.getObservation("answer-0")).toMatchObject({
      status: "failed",
      error: "INSUFFICIENT_CREDITS",
    });
  });
});

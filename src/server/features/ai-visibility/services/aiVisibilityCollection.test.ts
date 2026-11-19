import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { aiObservations, projectCompetitors } from "@/db/schema";
import { AiVisibilityRepository as repo } from "../repositories/AiVisibilityRepository";
import {
  collectAiLiveBatch,
  collectAiModelBatch,
  collectAiRound,
  collectLateAiAnswers,
  postAiBatch,
  prepareAiRun,
} from "./aiVisibilityCollection";
import { finalizeAiRun } from "./aiVisibilityRunOutcome";
import { configuration, customer } from "./aiVisibilityTestFixtures";

const { testDb, dataforseo } = await vi.hoisted(async () => {
  const { createAiVisibilityTestDb } = await import("../aiVisibilityTestDb");
  return {
    testDb: await createAiVisibilityTestDb(),
    dataforseo: {
      trackingTaskPost: vi.fn(),
      trackingLiveBatch: vi.fn(),
      trackingLiveBatchWithCosts: vi.fn(),
      fetchTaskResult: vi.fn(),
      llmResponse: vi.fn(),
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
      trackingLiveBatch: dataforseo.trackingLiveBatch,
      trackingLiveBatchWithCosts: dataforseo.trackingLiveBatchWithCosts,
      llmResponse: dataforseo.llmResponse,
    },
  }),
  fetchAiTrackingTaskResult: dataforseo.fetchTaskResult,
}));
vi.mock("@/server/lib/dataforseo/llm-models", () => ({
  resolveLatestLlmModelName: async () => "claude-sonnet-5",
}));

const runId = "run";
const market = { locationCode: 2840, languageCode: "en" };
const pendingTask = {
  tag: "answer-0",
  taskId: "task",
  costUsd: 0.002,
  engine: "chatgpt",
  prompt: "Which SEO tools?",
  attempts: 1,
} as const;
const liveAnswer = {
  status: "fulfilled",
  value: { status: "completed", result: { markdown: "OpenSEO", sources: [] } },
} as const;
const billedLiveAnswer = {
  status: "fulfilled",
  value: { data: liveAnswer.value, providerCostUsd: 0.004 },
} as const;
const providerFailure = {
  status: "failed",
  message: "Internal Server Error.",
  code: "UPSTREAM_UNAVAILABLE",
  retryable: true,
} as const;
const billedProviderFailure = {
  status: "fulfilled",
  value: { data: providerFailure, providerCostUsd: 0.004 },
} as const;

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
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
    prompts: [{ text: "Which SEO tools?" }, { text: "Best rank tracker?" }],
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
    rows.prompts.map((prompt, index) => ({
      id: `answer-${index}`,
      runId,
      promptId: prompt.id,
      engine: "chatgpt",
      branded: false,
    })),
  );
});

describe("AI answer collection", () => {
  it("stops a scheduled workflow before provider dispatch when tracking was paused", async () => {
    await repo.updateRun(runId, { trigger: "scheduled", status: "queued" });

    await expect(prepareAiRun(runId)).rejects.toThrow(
      "Scheduled tracking was paused before provider dispatch.",
    );

    expect(await repo.getRunInternal(runId)).toMatchObject({
      status: "queued",
    });
    expect(dataforseo.trackingTaskPost).not.toHaveBeenCalled();
    expect(dataforseo.trackingLiveBatch).not.toHaveBeenCalled();
    expect(dataforseo.llmResponse).not.toHaveBeenCalled();
  });

  it("does not resurrect a scheduled run canceled after its authorization read", async () => {
    const tracker = await repo.getTracker("project");
    if (!tracker) throw new Error("Tracker fixture was not saved.");
    await repo.updateTracker(tracker.id, { enabled: true });
    await repo.updateRun(runId, { trigger: "scheduled", status: "queued" });

    const getConfiguration = repo.getConfiguration.bind(repo);
    vi.spyOn(repo, "getConfiguration").mockImplementation(async (projectId) => {
      const config = await getConfiguration(projectId);
      if (config) {
        await repo.updateTracker(config.tracker.id, {
          enabled: false,
          lastSkipReason: "Scheduled tracking is paused.",
        });
      }
      return config;
    });

    await expect(prepareAiRun(runId)).rejects.toThrow(
      "The scheduled check was canceled before provider dispatch.",
    );

    expect(await repo.getRunInternal(runId)).toMatchObject({
      status: "failed",
    });
    expect(await repo.getObservations([runId])).toMatchObject([
      { status: "failed", error: "Scheduled tracking is paused." },
      { status: "failed", error: "Scheduled tracking is paused." },
    ]);
    expect(dataforseo.trackingTaskPost).not.toHaveBeenCalled();
    expect(dataforseo.trackingLiveBatch).not.toHaveBeenCalled();
    expect(dataforseo.llmResponse).not.toHaveBeenCalled();
  });

  it("saves an answer with its citations and each brand's mention and citation", async () => {
    dataforseo.fetchTaskResult.mockResolvedValue({
      status: "completed",
      result: {
        markdown:
          "Try **Ahrefs** or OpenSEO [1](https://openseo.so/pricing?utm_source=chatgpt)",
        sources: [
          {
            url: "https://openseo.so/pricing?utm_source=chatgpt",
            title: "Pricing",
          },
        ],
      },
    });

    const round = await collectAiRound(runId, [pendingTask], true);

    expect(round).toEqual({ pending: [], retry: [] });
    expect(await repo.getObservation("answer-0")).toMatchObject({
      status: "completed",
    });
    const evidence = await repo.getEvidence(["answer-0"]);
    expect(evidence.sources).toMatchObject([
      { url: "https://openseo.so/pricing", domain: "openseo.so", position: 1 },
    ]);
    expect(evidence.matches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          domain: "openseo.so",
          own: true,
          mentioned: true,
          cited: true,
          firstMention: 14,
        }),
        expect.objectContaining({
          domain: "ahrefs.com",
          own: false,
          mentioned: true,
          cited: false,
          firstMention: 4,
        }),
      ]),
    );
    // A retried step skips the answer an earlier attempt already saved.
    await collectAiRound(runId, [pendingTask], true);
    expect(dataforseo.fetchTaskResult).toHaveBeenCalledTimes(1);
  });

  it("fails the answers DataForSEO did not accept and collects the rest", async () => {
    dataforseo.trackingTaskPost.mockResolvedValue({
      tasks: [{ tag: "answer-0", taskId: "task", costUsd: 0.002 }],
      hold: null,
      providerCostUsd: 0.003,
    });

    const result = await postAiBatch(runId, customer, market, {
      engine: "chatgpt",
      tasks: [
        { tag: "answer-0", prompt: "Which SEO tools?" },
        { tag: "answer-1", prompt: "Best rank tracker?" },
      ],
    });

    expect(result.pending).toEqual([pendingTask]);
    expect(result).toMatchObject({
      providerCostUsd: 0.003,
      providerCostKnown: true,
    });
    expect(await repo.getObservation("answer-1")).toMatchObject({
      status: "failed",
    });
  });

  it("counts the attempt of an answer posted again, so its retries stop at 3", async () => {
    dataforseo.trackingTaskPost.mockResolvedValue({
      tasks: [{ tag: "answer-0", taskId: "task", costUsd: 0.002 }],
      hold: null,
      providerCostUsd: 0.003,
    });

    const { pending } = await postAiBatch(runId, customer, market, {
      engine: "chatgpt",
      tasks: [{ tag: "answer-0", prompt: "Which SEO tools?", attempts: 2 }],
    });

    expect(pending).toEqual([{ ...pendingTask, attempts: 3 }]);
  });

  it("returns a queued answer DataForSEO's backend failed for a new post, and fails it after the last attempt", async () => {
    dataforseo.fetchTaskResult.mockResolvedValue(providerFailure);

    const round = await collectAiRound(
      runId,
      [
        pendingTask,
        {
          ...pendingTask,
          tag: "answer-1",
          prompt: "Best rank tracker?",
          attempts: 3,
        },
      ],
      true,
    );

    expect(round.retry).toEqual([
      {
        engine: "chatgpt",
        tasks: [{ tag: "answer-0", prompt: "Which SEO tools?", attempts: 1 }],
      },
    ]);
    expect(await repo.getObservation("answer-1")).toMatchObject({
      status: "failed",
      error: "UPSTREAM_UNAVAILABLE",
    });
  });

  it("fails closed before dispatching a model API batch with variable cost", async () => {
    const runBefore = await repo.getRunInternal(runId);
    const [{ promptId }] = await repo.getObservations([runId]);
    await testDb.db.insert(aiObservations).values({
      id: "answer-claude",
      runId,
      promptId,
      engine: "claude",
      branded: false,
    });

    await expect(prepareAiRun(runId)).rejects.toThrow(
      "without an enforceable provider-cost ceiling",
    );
    await expect(
      collectAiModelBatch(runId, customer, market, {
        engine: "claude",
        tasks: [{ tag: "answer-claude", prompt: "Which SEO tools?" }],
      }),
    ).rejects.toThrow("no enforceable provider-cost ceiling");
    expect(dataforseo.llmResponse).not.toHaveBeenCalled();
    expect(await repo.getRunInternal(runId)).toMatchObject({
      status: runBefore?.status,
    });
  });

  it("collects a manual run live, saving answers and failing rejected calls", async () => {
    expect(await prepareAiRun(runId)).toMatchObject({ live: true });
    dataforseo.trackingLiveBatchWithCosts.mockResolvedValue([
      billedLiveAnswer,
      { status: "rejected", reason: new Error("Timed out") },
    ]);

    const outcome = await collectAiLiveBatch(runId, customer, market, [
      { tag: "answer-0", prompt: "Which SEO tools?", engine: "chatgpt" },
      { tag: "answer-1", prompt: "Best rank tracker?", engine: "chatgpt" },
    ]);

    expect(await repo.getObservation("answer-0")).toMatchObject({
      status: "completed",
    });
    expect(await repo.getObservation("answer-1")).toMatchObject({
      status: "failed",
      error: "INTERNAL_ERROR",
    });
    expect(dataforseo.trackingLiveBatchWithCosts).toHaveBeenCalledOnce();
    expect(outcome).toEqual({
      providerCostUsd: 0.004,
      providerCostKnown: false,
    });
  });

  it("asks a live answer again when DataForSEO's backend fails it, up to 3 attempts", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    dataforseo.trackingLiveBatchWithCosts
      .mockResolvedValueOnce([billedProviderFailure, billedProviderFailure])
      .mockResolvedValueOnce([billedLiveAnswer, billedProviderFailure])
      .mockResolvedValueOnce([billedProviderFailure]);

    const collecting = collectAiLiveBatch(runId, customer, market, [
      { tag: "answer-0", prompt: "Which SEO tools?", engine: "chatgpt" },
      { tag: "answer-1", prompt: "Best rank tracker?", engine: "chatgpt" },
    ]);
    await vi.runAllTimersAsync();
    await collecting;

    expect(dataforseo.trackingLiveBatchWithCosts).toHaveBeenCalledTimes(3);
    expect(await repo.getObservation("answer-0")).toMatchObject({
      status: "completed",
    });
    expect(await repo.getObservation("answer-1")).toMatchObject({
      status: "failed",
      error: "UPSTREAM_UNAVAILABLE",
    });
  });

  it("saves the rest of a paid live batch when one answer cannot be saved", async () => {
    dataforseo.trackingLiveBatchWithCosts.mockResolvedValue([
      billedLiveAnswer,
      billedLiveAnswer,
    ]);
    vi.spyOn(repo, "persistAnswer").mockRejectedValueOnce(new Error("D1"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    await collectAiLiveBatch(runId, customer, market, [
      { tag: "answer-0", prompt: "Which SEO tools?", engine: "chatgpt" },
      { tag: "answer-1", prompt: "Best rank tracker?", engine: "chatgpt" },
    ]);

    expect(await repo.getObservation("answer-0")).toMatchObject({
      status: "pending",
    });
    expect(await repo.getObservation("answer-1")).toMatchObject({
      status: "completed",
    });
  });

  it("fills in an answer that arrives after the run finished, and clears the notice", async () => {
    dataforseo.fetchTaskResult.mockResolvedValue(liveAnswer.value);
    await collectAiRound(runId, [pendingTask], true);
    await finalizeAiRun(runId);

    const late = { ...pendingTask, tag: "answer-1" };
    expect(await collectLateAiAnswers(runId, [late])).toEqual([]);

    expect(await repo.getObservation("answer-1")).toMatchObject({
      status: "completed",
      error: null,
    });
    expect(await repo.getRunInternal(runId)).toMatchObject({
      status: "completed",
    });
    expect((await repo.getTracker("project"))?.lastSkipReason).toBeNull();
  });
});

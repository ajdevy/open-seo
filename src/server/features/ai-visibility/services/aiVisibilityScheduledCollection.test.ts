import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { projects } from "@/db/schema";
import { AiVisibilityRepository as repo } from "../repositories/AiVisibilityRepository";
import { prepareAiRun } from "./aiVisibilityCollection";
import { configuration } from "./aiVisibilityTestFixtures";

const { testDb, dataforseo } = await vi.hoisted(async () => {
  const { createAiVisibilityTestDb } = await import("../aiVisibilityTestDb");
  return {
    testDb: await createAiVisibilityTestDb(),
    dataforseo: {
      trackingTaskPost: vi.fn(),
      trackingLiveBatch: vi.fn(),
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
      llmResponse: dataforseo.llmResponse,
    },
  }),
  fetchAiTrackingTaskResult: dataforseo.fetchTaskResult,
}));
vi.mock("@/server/lib/dataforseo/llm-models", () => ({
  resolveLatestLlmModelName: async () => "claude-sonnet-5",
}));

const runId = "scheduled-run";
const market = { locationCode: 2840, languageCode: "en" };

beforeEach(async () => {
  vi.clearAllMocks();
  await testDb.seedProject();
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
      trigger: "scheduled",
      status: "queued",
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe("scheduled answer collection authorization", () => {
  it("stops before provider dispatch when tracking was paused", async () => {
    await expect(prepareAiRun(runId)).rejects.toThrow(
      "Scheduled tracking was paused before provider dispatch.",
    );

    expect(await repo.getRunInternal(runId)).toMatchObject({ status: "queued" });
    expect(dataforseo.trackingTaskPost).not.toHaveBeenCalled();
    expect(dataforseo.trackingLiveBatch).not.toHaveBeenCalled();
    expect(dataforseo.llmResponse).not.toHaveBeenCalled();
  });

  it("does not resurrect a run canceled after its authorization read", async () => {
    const tracker = await repo.getTracker("project");
    if (!tracker) throw new Error("Tracker fixture was not saved.");
    await repo.updateTracker(tracker.id, { enabled: true });

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

    expect(await repo.getRunInternal(runId)).toMatchObject({ status: "failed" });
    expect(await repo.getObservations([runId])).toMatchObject([
      { status: "failed", error: "Scheduled tracking is paused." },
      { status: "failed", error: "Scheduled tracking is paused." },
    ]);
    expect(dataforseo.trackingTaskPost).not.toHaveBeenCalled();
    expect(dataforseo.trackingLiveBatch).not.toHaveBeenCalled();
    expect(dataforseo.llmResponse).not.toHaveBeenCalled();
  });

  it("cancels an archived project at queued-to-running admission", async () => {
    const tracker = await repo.getTracker("project");
    if (!tracker) throw new Error("Tracker fixture was not saved.");
    await repo.updateTracker(tracker.id, {
      enabled: true,
      pendingScheduledRunId: runId,
    });

    const isProjectActive = repo.isProjectActive.bind(repo);
    vi.spyOn(repo, "isProjectActive").mockImplementation(async (projectId) => {
      const active = await isProjectActive(projectId);
      if (active)
        await testDb.db
          .update(projects)
          .set({ archivedAt: "2026-09-05T12:00:00.000Z" })
          .where(eq(projects.id, projectId));
      return active;
    });

    await expect(prepareAiRun(runId)).rejects.toThrow(
      "The scheduled check was canceled before provider dispatch.",
    );

    expect(await repo.getRunInternal(runId)).toMatchObject({ status: "failed" });
    expect(await repo.getObservations([runId])).toMatchObject([
      {
        status: "failed",
        error: "The scheduled check was canceled because its project was archived or it was no longer queued before provider dispatch.",
      },
      {
        status: "failed",
        error: "The scheduled check was canceled because its project was archived or it was no longer queued before provider dispatch.",
      },
    ]);
    expect(await repo.getTracker("project")).toMatchObject({
      pendingScheduledRunId: null,
      lastSkipReason:
        "The scheduled check was canceled because its project was archived or it was no longer queued before provider dispatch.",
    });
    expect(dataforseo.trackingTaskPost).not.toHaveBeenCalled();
    expect(dataforseo.trackingLiveBatch).not.toHaveBeenCalled();
    expect(dataforseo.llmResponse).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { aiNativeResults, projects } from "@/db/schema";
import { AiVisibilityRepository as repo } from "../repositories/AiVisibilityRepository";
import { AiNativeResultRepository as nativeRepo } from "../repositories/AiNativeResultRepository";
import { getRun } from "./aiVisibilityRuns";
import { loadAiResults } from "./aiVisibilityResults";
import {
  createAiNativeRun,
  recordAiNativeRunResult,
} from "./aiVisibilitySyntheticRuns";
import { configuration, customer } from "./aiVisibilityTestFixtures";

const { testDb, workflow } = await vi.hoisted(async () => {
  const { createAiVisibilityTestDb } = await import("../aiVisibilityTestDb");
  return {
    testDb: await createAiVisibilityTestDb(),
    workflow: { create: vi.fn(), get: vi.fn() },
  };
});
vi.mock("cloudflare:workers", () => ({
  env: { DATABASE_PROVIDER: "d1", AI_VISIBILITY_WORKFLOW: workflow },
}));
vi.mock("@/db", () => ({ db: testDb.db }));
vi.mock("@/db/runBatch", () => ({ runBatch: testDb.runBatch }));
vi.mock("@/server/lib/runtime-env", () => ({
  getOptionalEnvValue: async () => "dataforseo-key",
  isHostedServerAuthMode: async () => false,
}));

const projectId = "00000000-0000-4000-8000-000000000101";
const resultInput = (
  runId: string,
  resultId: string,
  resultStatus: "completed" | "failed",
) => ({
  projectId,
  runId,
  resultId,
  resultStatus,
  answer: resultStatus === "completed" ? "OpenSEO is useful." : null,
  searchStatus: resultStatus === "completed" ? "completed" : "failed",
  searchEvidence: [
    { tool: "web_search", status: "completed", evidenceRef: "event-1" },
  ],
  searchSources: ["https://search.example/result"],
  sources: ["https://openseo.so/features"],
  eligibleForVisibility: resultStatus === "completed",
});

beforeEach(async () => {
  await testDb.seedProject();
  const sourceProject = await repo.getProject("project");
  if (!sourceProject) throw new Error("Seed project is missing");
  await testDb.db.insert(projects).values({
    ...sourceProject,
    id: projectId,
    name: "OpenSEO Synthetic Test",
  });
  const config = configuration(
    {
      engines: ["chatgpt"],
      prompts: [
        { text: "Which SEO tools are worth evaluating?" },
        { text: "How should I compare SEO platforms?" },
      ],
    },
    projectId,
  );
  await repo.saveConfiguration(config);
  vi.clearAllMocks();
});

describe("synthetic AI visibility runs", () => {
  it("creates one server run, records tasks, and serves repeatable reads without a workflow", async () => {
    const config = await repo.getConfiguration(projectId);
    if (!config) throw new Error("Saved tracker is missing");
    const created = await createAiNativeRun(
      {
        projectId,
        questionIds: [config.prompts[0].id],
        targets: [
          { requestedModel: "model-a", route: "codex_cli" },
          { requestedModel: "model-b", route: "cursor_acp" },
        ],
      },
      customer,
    );

    expect(created.run).toMatchObject({
      status: "running",
      expected: 2,
      completed: 0,
      failed: 0,
      pending: 2,
    });
    expect(created.tasks).toHaveLength(2);
    expect(new Set(created.tasks.map((task) => task.resultId)).size).toBe(2);
    expect(await repo.listRuns(projectId)).toHaveLength(1);
    expect(
      await testDb.db
        .select()
        .from(aiNativeResults)
        .where(eq(aiNativeResults.runId, created.run.id)),
    ).toHaveLength(2);
    expect(workflow.create).not.toHaveBeenCalled();
    expect(workflow.get).not.toHaveBeenCalled();

    const first = await getRun({ projectId, runId: created.run.id });
    const second = await getRun({ projectId, runId: created.run.id });
    const results = await loadAiResults({
      projectId,
      runId: created.run.id,
      includeHistory: false,
      competitorGap: false,
      branded: "all",
      limit: 25,
    });
    expect(first).toEqual(second);
    expect(results.nativeResults).toHaveLength(2);
    expect(results.coverage).toEqual({
      expected: 2,
      completed: 0,
      noAnswer: 0,
      failed: 0,
      pending: 2,
    });
    expect(await repo.listRuns(projectId)).toHaveLength(1);
  });

  it("accepts scoped final results once and reports partial completion", async () => {
    const config = await repo.getConfiguration(projectId);
    if (!config) throw new Error("Saved tracker is missing");
    const created = await createAiNativeRun(
      {
        projectId,
        questionIds: [config.prompts[0].id],
        targets: [
          { requestedModel: "model-a", route: "codex_cli" },
          { requestedModel: "model-b", route: "cursor_acp" },
        ],
      },
      customer,
    );

    const completedInput = resultInput(
      created.run.id,
      created.tasks[0].resultId,
      "completed",
    );
    const completed = await recordAiNativeRunResult(completedInput, customer);
    expect(completed.run).toMatchObject({
      status: "running",
      completed: 1,
      failed: 0,
      pending: 1,
    });
    await expect(
      recordAiNativeRunResult(completedInput, customer),
    ).resolves.toMatchObject({
      run: { status: "running", completed: 1, pending: 1 },
    });

    const failed = await recordAiNativeRunResult(
      resultInput(created.run.id, created.tasks[1].resultId, "failed"),
      customer,
    );
    expect(failed.run).toMatchObject({
      status: "partial",
      completed: 1,
      failed: 1,
      pending: 0,
    });
    expect(await nativeRepo.listByRuns(projectId, [created.run.id])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: created.tasks[0].resultId,
          resultStatus: "completed",
        }),
        expect.objectContaining({
          id: created.tasks[1].resultId,
          resultStatus: "failed",
        }),
      ]),
    );
    const results = await loadAiResults({
      projectId,
      runId: created.run.id,
      includeHistory: false,
      competitorGap: false,
      branded: "all",
      limit: 25,
    });
    expect(results.coverage).toEqual({
      expected: 2,
      completed: 1,
      noAnswer: 0,
      failed: 1,
      pending: 0,
    });
    expect(await repo.listRuns(projectId)).toHaveLength(1);
    expect(workflow.create).not.toHaveBeenCalled();
    expect(workflow.get).not.toHaveBeenCalled();
  });

  it("does not reveal or write a task outside the billing client", async () => {
    const config = await repo.getConfiguration(projectId);
    if (!config) throw new Error("Saved tracker is missing");
    const created = await createAiNativeRun(
      {
        projectId,
        questionIds: [config.prompts[0].id],
        targets: [{ requestedModel: "model-a", route: "codex_cli" }],
      },
      customer,
    );
    await expect(
      recordAiNativeRunResult(
        resultInput(created.run.id, created.tasks[0].resultId, "completed"),
        { ...customer, organizationId: "another-organization" },
      ),
    ).rejects.toMatchObject({ reason: "RUN_NOT_FOUND" });
    expect(
      await nativeRepo.listByRuns(projectId, [created.run.id]),
    ).toMatchObject([{ resultStatus: "pending", answer: null }]);
  });
});

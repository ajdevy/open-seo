import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { aiNativeResults, projects } from "@/db/schema";
import { AiVisibilityRepository as repo } from "@/server/features/ai-visibility/repositories/AiVisibilityRepository";
import {
  configuration,
  customer,
} from "@/server/features/ai-visibility/services/aiVisibilityTestFixtures";
import {
  createAiVisibilityNativeRun,
  getAiVisibilityResults,
  getAiVisibilityRun,
  recordAiVisibilityNativeRunResult,
} from "@/serverFunctions/ai-visibility";

const { testDb, workflow, serverContext } = await vi.hoisted(async () => {
  const { createAiVisibilityTestDb } =
    await import("@/server/features/ai-visibility/aiVisibilityTestDb");
  return {
    testDb: await createAiVisibilityTestDb(),
    workflow: { create: vi.fn(), get: vi.fn() },
    serverContext: { current: null as Record<string, unknown> | null },
  };
});

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => ({
    middleware: () => ({
      validator: (schema: { parse: (value: unknown) => unknown }) => ({
        handler:
          (handler: (input: { data: unknown; context: unknown }) => unknown) =>
          async ({ data }: { data: unknown }) => {
            if (!serverContext.current)
              throw new Error("Test server context is missing");
            return handler({
              data: schema.parse(data),
              context: serverContext.current,
            });
          },
      }),
    }),
  }),
}));
vi.mock("@tanstack/react-start/server", () => ({ getRequest: vi.fn() }));
vi.mock("@/serverFunctions/middleware", () => ({ requireProjectContext: [] }));
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
const otherProjectId = "00000000-0000-4000-8000-000000000102";
let promptId = "";

function projectContext(scopedProjectId: string) {
  return {
    ...customer,
    userEmail: customer.userEmail,
    emailVerified: true,
    role: "owner",
    project: { id: scopedProjectId },
    projectId: scopedProjectId,
  };
}

beforeEach(async () => {
  await testDb.seedProject();
  const sourceProject = await repo.getProject("project");
  if (!sourceProject) throw new Error("Seed project is missing");
  await testDb.db.insert(projects).values({
    ...sourceProject,
    id: projectId,
    name: "Native Run API Test",
  });
  const config = configuration(
    {
      engines: ["chatgpt"],
      prompts: [{ text: "Which SEO tools are worth evaluating?" }],
    },
    projectId,
  );
  promptId = config.prompts[0].id;
  await repo.saveConfiguration(config);
  serverContext.current = projectContext(projectId);
  vi.clearAllMocks();
});

describe("AI visibility native run server functions", () => {
  it("creates, records, and repeatably reads one project-scoped run", async () => {
    const created = await createAiVisibilityNativeRun({
      data: {
        projectId,
        questionIds: [promptId],
        targets: [{ requestedModel: "model-a", route: "codex_cli" }],
      },
    });
    const runId = created.run.id;
    const [task] = created.tasks;
    const recordInput = {
      projectId,
      runId,
      resultId: task.resultId,
      resultStatus: "completed" as const,
      answer: "A synthetic answer.",
      searchStatus: "completed",
      searchEvidence: [
        { tool: "web_search", status: "completed", evidenceRef: "event-1" },
      ],
      searchSources: [],
      sources: [],
      eligibleForVisibility: true,
    };

    const recorded = await recordAiVisibilityNativeRunResult({
      data: recordInput,
    });
    const run = await getAiVisibilityRun({ data: { projectId, runId } });
    const runAgain = await getAiVisibilityRun({
      data: { projectId, runId },
    });
    const results = await getAiVisibilityResults({
      data: { projectId, runId, branded: "all" },
    });
    const resultsAgain = await getAiVisibilityResults({
      data: { projectId, runId, branded: "all" },
    });

    expect(created.run).toMatchObject({ id: runId, expected: 1 });
    expect(recorded).toMatchObject({ runId, resultId: task.resultId });
    expect(run).toMatchObject({ id: runId, status: "completed", completed: 1 });
    expect(runAgain).toEqual(run);
    expect(results.runId).toBe(runId);
    expect(results.nativeResults).toMatchObject([
      {
        id: task.resultId,
        runId,
        questionId: promptId,
        answer: "A synthetic answer.",
      },
    ]);
    expect(resultsAgain).toEqual(results);
    expect(await repo.listRuns(projectId)).toHaveLength(1);
    expect(workflow.create).not.toHaveBeenCalled();
    expect(workflow.get).not.toHaveBeenCalled();
  });

  it("rejects another project's run for reads and result recording", async () => {
    const sourceProject = await repo.getProject("project");
    if (!sourceProject) throw new Error("Seed project is missing");
    await testDb.db.insert(projects).values({
      ...sourceProject,
      id: otherProjectId,
      name: "Other Project",
    });
    const otherConfig = configuration(
      {
        engines: ["chatgpt"],
        prompts: [{ text: "What should I compare?" }],
      },
      otherProjectId,
    );
    await repo.saveConfiguration(otherConfig);

    await expect(
      createAiVisibilityNativeRun({
        data: {
          projectId: otherProjectId,
          questionIds: [otherConfig.prompts[0].id],
          targets: [{ requestedModel: "model-a", route: "codex_cli" }],
        },
      }),
    ).rejects.toMatchObject({ reason: "INVALID_PROMPT_SELECTION" });
    expect(await repo.listRuns(projectId)).toHaveLength(0);
    expect(await repo.listRuns(otherProjectId)).toHaveLength(0);

    serverContext.current = projectContext(otherProjectId);
    const foreignRun = await createAiVisibilityNativeRun({
      data: {
        projectId: otherProjectId,
        questionIds: [otherConfig.prompts[0].id],
        targets: [{ requestedModel: "model-a", route: "codex_cli" }],
      },
    });
    const [task] = foreignRun.tasks;
    serverContext.current = projectContext(projectId);

    await expect(
      getAiVisibilityRun({
        data: { projectId: otherProjectId, runId: foreignRun.run.id },
      }),
    ).rejects.toMatchObject({ reason: "RUN_NOT_FOUND" });
    await expect(
      getAiVisibilityResults({
        data: { projectId: otherProjectId, runId: foreignRun.run.id },
      }),
    ).rejects.toMatchObject({ reason: "RUN_NOT_FOUND" });
    await expect(
      recordAiVisibilityNativeRunResult({
        data: {
          projectId: otherProjectId,
          runId: foreignRun.run.id,
          resultId: task.resultId,
          resultStatus: "completed",
          answer: "Must not be recorded in another project.",
          searchStatus: "completed",
          searchEvidence: [
            { tool: "web_search", status: "completed", evidenceRef: "event-1" },
          ],
          searchSources: [],
          sources: [],
          eligibleForVisibility: true,
        },
      }),
    ).rejects.toMatchObject({ reason: "RUN_NOT_FOUND" });
    expect(
      await testDb.db
        .select({ status: aiNativeResults.resultStatus })
        .from(aiNativeResults)
        .where(eq(aiNativeResults.id, task.resultId)),
    ).toEqual([{ status: "pending" }]);
  });
});

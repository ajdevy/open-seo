import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  aiNativeResults,
  aiNativeSearchEvidence,
  aiNativeSearchSources,
  aiNativeSources,
  aiPrompts,
  aiRuns,
} from "@/db/schema";
import { aiResultsOutput } from "@/server/mcp/tools/ai-visibility-output-schemas";
import { AiVisibilityRepository as repo } from "../repositories/AiVisibilityRepository";
import { loadAiResults } from "./aiVisibilityResults";
import { saveAiNativeResult } from "./aiVisibilityNativeResults";
import { configuration } from "./aiVisibilityTestFixtures";

const { testDb } = await vi.hoisted(async () => {
  const { createAiVisibilityTestDb } = await import("../aiVisibilityTestDb");
  return { testDb: await createAiVisibilityTestDb() };
});
vi.mock("cloudflare:workers", () => ({ env: { DATABASE_PROVIDER: "d1" } }));
vi.mock("@/db", () => ({ db: testDb.db }));
vi.mock("@/db/runBatch", () => ({ runBatch: testDb.runBatch }));

const runId = "native-run";
const timestamp = "2026-10-01T12:00:00.000Z";
let questionId = "";
let question = "";

function result(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    client_id: "organization",
    project_id: "project",
    run_id: runId,
    question_id: questionId,
    question_version: 7,
    result_id: "native-result-a",
    timestamp,
    question,
    requested_model: "model-a",
    observed_model: null,
    route: "codex_cli",
    result_status: "completed",
    answer: "OpenSEO is a useful SEO tool.",
    search_status: "unknown",
    search_evidence: [
      { tool: "web_search", status: "unknown", evidence_ref: "event-1" },
    ],
    search_sources: ["https://search.example/result"],
    sources: ["https://openseo.example/pricing"],
    eligible_for_visibility: null,
    error_code: null,
    turn_status: null,
    ...overrides,
  };
}

beforeEach(async () => {
  await testDb.seedProject();
  const config = configuration({
    engines: ["chatgpt"],
    prompts: [{ text: "Which SEO tools are worth evaluating?" }],
  });
  questionId = config.prompts[0].id;
  question = config.prompts[0].text;
  await repo.saveConfiguration(config);
  await repo.createRun(
    {
      id: runId,
      trackerId: config.tracker.id,
      projectId: "project",
      trigger: "baseline",
      status: "completed",
      locationCode: 2840,
      languageCode: "en",
      createdAt: timestamp,
      completedAt: timestamp,
    },
    [
      {
        id: "legacy-observation",
        runId,
        promptId: questionId,
        engine: "chatgpt",
        branded: false,
        status: "completed",
        answerMarkdown: "Legacy answer remains readable.",
        collectedAt: timestamp,
      },
    ],
  );
});

describe("native model result storage", () => {
  it("keeps models and routes separate and reads normalized evidence with the run", async () => {
    await saveAiNativeResult(result());
    await saveAiNativeResult(
      result({
        result_id: "native-result-b",
        requested_model: "model-b",
        question_version: 7,
        answer: "A second model answer.",
        search_status: "completed",
        search_sources: [
          "https://search.example/first",
          "https://search.example/second",
        ],
        sources: ["https://other.example/cited"],
      }),
    );
    await saveAiNativeResult(
      result({ result_id: "native-result-c", route: "cursor_acp" }),
    );

    const results = await loadAiResults({
      projectId: "project",
      runId,
      includeHistory: false,
      competitorGap: false,
      branded: "all",
      limit: 25,
    });

    expect(results.rows).toHaveLength(1);
    expect(results.nativeResults).toMatchObject([
      {
        id: "native-result-a",
        clientId: "organization",
        questionVersion: 7,
        question,
        requestedModel: "model-a",
        route: "codex_cli",
        searchStatus: "unknown",
        searchEvidence: [
          { tool: "web_search", status: "unknown", evidenceRef: "event-1" },
        ],
      },
      {
        id: "native-result-c",
        requestedModel: "model-a",
        route: "cursor_acp",
      },
      {
        id: "native-result-b",
        requestedModel: "model-b",
        route: "codex_cli",
        searchStatus: "completed",
        searchSources: [
          "https://search.example/first",
          "https://search.example/second",
        ],
        sources: ["https://other.example/cited"],
      },
    ]);
    expect(await testDb.db.select().from(aiNativeSources)).toHaveLength(3);
    expect(await testDb.db.select().from(aiNativeSearchSources)).toHaveLength(
      4,
    );
    expect(await testDb.db.select().from(aiNativeSearchEvidence)).toHaveLength(
      3,
    );
    expect(await testDb.db.select().from(aiNativeResults)).toHaveLength(3);
    expect(aiResultsOutput.parse(results).nativeResults).toHaveLength(3);
    expect(await repo.getObservation("legacy-observation")).toMatchObject({
      status: "completed",
      answerMarkdown: "Legacy answer remains readable.",
    });
  });

  it("keeps the historical question snapshot when a later edit adds a new prompt", async () => {
    await saveAiNativeResult(result());
    const oldPrompt = (
      await testDb.db
        .select()
        .from(aiPrompts)
        .where(eq(aiPrompts.id, questionId))
    )[0];
    expect(oldPrompt).toBeDefined();
    await testDb.db
      .update(aiPrompts)
      .set({ archived: true })
      .where(eq(aiPrompts.id, questionId));
    await testDb.db.insert(aiPrompts).values({
      id: "edited-prompt",
      trackerId: oldPrompt.trackerId,
      topic: oldPrompt.topic,
      text: "Which SEO tools should I compare now?",
      paused: false,
      archived: false,
      createdAt: "2026-10-02T12:00:00.000Z",
    });

    const saved = await loadAiResults({
      projectId: "project",
      runId,
      includeHistory: false,
      competitorGap: false,
      branded: "all",
      limit: 25,
    });

    expect(saved.nativeResults).toMatchObject([
      {
        id: "native-result-a",
        questionId,
        questionVersion: 7,
        question: "Which SEO tools are worth evaluating?",
      },
    ]);
    await expect(
      saveAiNativeResult(
        result({ question: "Which SEO tools should I compare now?" }),
      ),
    ).rejects.toThrow("question text does not match its saved version");
    expect(
      await testDb.db.select().from(aiRuns).where(eq(aiRuns.id, runId)),
    ).toHaveLength(1);
  });

  it("redelivers one logical result without duplicating its source or evidence rows", async () => {
    const input = result();
    await saveAiNativeResult(input);
    await saveAiNativeResult(input);

    expect(await testDb.db.select().from(aiNativeResults)).toHaveLength(1);
    expect(await testDb.db.select().from(aiNativeSources)).toHaveLength(1);
    expect(await testDb.db.select().from(aiNativeSearchSources)).toHaveLength(
      1,
    );
    expect(await testDb.db.select().from(aiNativeSearchEvidence)).toHaveLength(
      1,
    );
  });

  it("allows a late final result for the same model route to replace its earlier details", async () => {
    await saveAiNativeResult(
      result({
        result_status: "partial",
        answer: "The response is still partial.",
        search_status: "partial",
        search_evidence: [],
        search_sources: [],
        sources: [],
      }),
    );
    const [partial] = await testDb.db.select().from(aiNativeResults);
    expect(partial).toMatchObject({
      resultStatus: "partial",
      answer: "The response is still partial.",
      searchStatus: "partial",
    });

    await saveAiNativeResult(
      result({
        result_status: "completed",
        timestamp: "2026-10-01T12:05:00.000Z",
        answer: "The late answer arrived.",
        search_status: "completed",
        search_evidence: [
          { tool: "web_search", status: "completed", evidence_ref: "event-2" },
        ],
        search_sources: ["https://search.example/late"],
        sources: ["https://answer.example/late"],
      }),
    );

    const [saved] = await testDb.db.select().from(aiNativeResults);
    expect(saved).toMatchObject({
      resultStatus: "completed",
      answer: "The late answer arrived.",
      searchStatus: "completed",
      collectedAt: "2026-10-01T12:05:00.000Z",
    });
    expect(await testDb.db.select().from(aiNativeSources)).toHaveLength(1);
    expect(await testDb.db.select().from(aiNativeSearchSources)).toHaveLength(
      1,
    );
    expect(await testDb.db.select().from(aiNativeSearchEvidence)).toHaveLength(
      1,
    );
  });

  it("rejects a result id rebound to a different model or client", async () => {
    await saveAiNativeResult(result());

    await expect(
      saveAiNativeResult(result({ requested_model: "model-b" })),
    ).rejects.toThrow("id is already bound to another result");
    await expect(
      saveAiNativeResult(result({ client_id: "another-client" })),
    ).rejects.toThrow("client, project, run, and question");
    await expect(
      saveAiNativeResult(result({ result_id: "different-id" })),
    ).rejects.toThrow("already exists");
    expect(await testDb.db.select().from(aiNativeResults)).toHaveLength(1);
  });
});

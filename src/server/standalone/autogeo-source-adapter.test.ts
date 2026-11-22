import { describe, expect, it } from "vitest";
import { clientRestoreArchiveSchema } from "./client-restore-schema";
import { prepareAutoGeoClientRestore } from "./autogeo-source-adapter";
import type { AutoGeoMapping } from "./autogeo-source-adapter-schema";
import { AUTOGEO_SOURCE_CONTRACT_REVISION } from "./autogeo-source-contract";

const at = "2026-11-16T10:00:00.000Z";

function bytes(value: string) {
  return new TextEncoder().encode(value);
}

function sourceAnswer(): Record<string, unknown> {
  return {
    answer_id: "answer-1",
    prompt_id: "prompt-1",
    provider: "provider-a",
    locale: "en",
    retrieval_mode: "retrieval",
    model_id: "model-a",
    asked_utc: "2026-10-01T10:00:00.000Z",
    status: "ok",
    attempt: 1,
    text: "A synthetic answer.",
    citations: ["https://example.test/source"],
    cost_usd: 0.001,
    cost_source: "reported",
    observed_version: "model-a-2026-10",
    search_executed: "executed",
    search_executed_evidence: "synthetic search evidence",
    counts_toward_retrieval_metrics: true,
    provider_call_id: "synthetic-call-1",
  };
}

function sourceArtifacts() {
  return {
    "prompts/matrix-v1.jsonl": bytes(
      `${JSON.stringify({
        id: "prompt-1",
        locale: "en",
        intent_category: "product_research",
        pair_id: null,
        entities: ["Example"],
        translation_of: null,
        text: "What is Example?",
      })}\n`,
    ),
    "runs/run-1/answers.jsonl": bytes(`${JSON.stringify(sourceAnswer())}\n`),
    "runs/run-1/claims.jsonl": bytes("opaque synthetic claim data\n"),
  };
}

function reviewedMapping(): AutoGeoMapping {
  return {
    clientRef: "synthetic-client-1",
    mappingEvidenceRef: "review/4-3/synthetic-map-1",
    sourceContractRevision: AUTOGEO_SOURCE_CONTRACT_REVISION,
    exportedAt: at,
    projects: [
      {
        id: "project-1",
        name: "Synthetic project",
        domain: "example.test",
        locationCode: 2840,
        languageCode: "en",
        createdAt: at,
        archivedAt: null,
        aiResearchKeywords: null,
      },
    ],
    trackers: [
      {
        id: "tracker-1",
        projectId: "project-1",
        locationCode: 2840,
        languageCode: "en",
        scheduleInterval: "weekly" as const,
        createdAt: at,
      },
    ],
    promptMappings: {
      "v1:prompt-1": {
        id: "mapped-prompt-v1-prompt-1",
        trackerId: "tracker-1",
        topic: "Product research",
        createdAt: at,
      },
    },
    runMappings: {
      "run-1": {
        trackerId: "tracker-1",
        projectId: "project-1",
        trigger: "scheduled" as const,
        status: "completed" as const,
        locationCode: 2840,
        languageCode: "en",
        createdAt: at,
        completedAt: at,
      },
    },
    answerMappings: {
      "run-1:answer-1": {
        sourceStatus: "ok",
        sourceProvider: "provider-a",
        engine: "chatgpt" as const,
        resultStatus: "completed" as const,
        collectedAt: "2026-10-01T10:01:00.000Z",
        confirmedCitationIndexes: [0],
      },
    },
  };
}

describe("AutoGeo source adapter", () => {
  it("builds a checksum-valid restore archive only from explicit mappings and preserves source bytes", async () => {
    const source = sourceArtifacts() as Record<string, Uint8Array>;
    const plan = await prepareAutoGeoClientRestore(source, reviewedMapping());

    expect(plan.canImport).toBe(false);
    expect(plan.mappingEvidenceRef).toBe("review/4-3/synthetic-map-1");
    expect(plan.archiveArtifacts).toEqual(source);
    expect(plan.report).toMatchObject({
      discoveredPrompts: 1,
      mappedPrompts: 1,
      discoveredAnswers: 1,
      mappedAnswers: 1,
      archiveOnlyArtifactFiles: 1,
      unmappedPrompts: 0,
      unmappedAnswers: 0,
    });
    expect(plan.archive).not.toBeNull();
    const archive = clientRestoreArchiveSchema.parse(plan.archive);
    expect(archive.payload.projects[0]).toMatchObject({
      organizationId: "autogeo:synthetic-client-1",
      name: "Synthetic project",
    });
    expect(archive.payload.projects[0]).not.toHaveProperty("indexnowKey");
    expect(archive.payload.aiTrackers[0]).toMatchObject({
      enabled: false,
      chatgpt: false,
      gemini: false,
      claude: false,
      perplexity: false,
      googleAiOverview: false,
      nextCheckAt: null,
    });
    expect(archive.payload.aiPrompts[0]).toMatchObject({
      id: "mapped-prompt-v1-prompt-1",
      text: "What is Example?",
      archived: true,
      paused: true,
    });
    expect(archive.payload.aiNativeResults[0]).toMatchObject({
      questionVersion: 1,
      questionSnapshot: "What is Example?",
      requestedModel: "model-a",
      observedModel: "model-a-2026-10",
      route: "unknown",
      resultStatus: "completed",
      searchStatus: "unknown",
      eligibleForVisibility: null,
      collectedAt: "2026-10-01T10:01:00.000Z",
    });
    expect(archive.payload.aiNativeSources).toEqual([
      expect.objectContaining({
        value: "https://example.test/source",
        position: 0,
      }),
    ]);
    expect(archive.payload.aiNativeSearchSources).toEqual([]);
    expect(archive.payload.aiNativeSearchEvidence).toEqual([]);
  });

  it("uses the source run path and does not infer route or search execution", async () => {
    const plan = await prepareAutoGeoClientRestore(
      sourceArtifacts(),
      reviewedMapping(),
    );

    expect(plan.archive).not.toBeNull();
    const archive = clientRestoreArchiveSchema.parse(plan.archive);
    expect(archive.payload.aiRuns[0].id).toBe("run-1");
    expect(archive.payload.aiNativeResults[0]).toMatchObject({
      runId: "run-1",
      searchStatus: "unknown",
      route: "unknown",
    });
  });

  it("keeps explicitly mapped prompts when the source has no answer runs", async () => {
    const source = sourceArtifacts() as Record<string, Uint8Array>;
    delete source["runs/run-1/answers.jsonl"];
    delete source["runs/run-1/claims.jsonl"];

    const plan = await prepareAutoGeoClientRestore(source, reviewedMapping());

    expect(plan.canImport).toBe(false);
    expect(plan.report).toMatchObject({
      discoveredPrompts: 1,
      mappedPrompts: 1,
      discoveredAnswers: 0,
      mappedAnswers: 0,
    });
    expect(plan.archive).not.toBeNull();
    const archive = clientRestoreArchiveSchema.parse(plan.archive);
    expect(archive.payload.aiPrompts).toHaveLength(1);
    expect(archive.payload.aiRuns).toEqual([]);
    expect(archive.payload.aiNativeResults).toEqual([]);
  });

  it("archives answers with ambiguous prompt versions instead of selecting one", async () => {
    const source = sourceArtifacts() as Record<string, Uint8Array>;
    source["prompts/matrix-v2.jsonl"] = bytes(
      `${JSON.stringify({
        id: "prompt-1",
        locale: "fr",
        intent_category: "product_research",
        pair_id: null,
        entities: ["Example"],
        translation_of: "prompt-1",
        text: "Qu'est-ce que Example ?",
      })}\n`,
    );
    const plan = await prepareAutoGeoClientRestore(source, reviewedMapping());

    expect(plan.archiveArtifacts).toEqual(source);
    expect(plan.report.unmappedAnswers).toBe(1);
    expect(plan.archive).toBeNull();
    expect(plan.report.blockers).toContain(
      "ambiguous_or_missing_prompt_version",
    );
  });

  it("archives malformed supported rows without echoing source values", async () => {
    const source = sourceArtifacts();
    source["runs/run-1/answers.jsonl"] = bytes(
      `${JSON.stringify({
        ...JSON.parse(
          new TextDecoder().decode(source["runs/run-1/answers.jsonl"]).trim(),
        ),
        unexpected_secret: "do-not-echo",
      })}\n`,
    );
    const plan = await prepareAutoGeoClientRestore(source, reviewedMapping());

    expect(plan.archiveArtifacts).toEqual(source);
    expect(plan.archive).toBeNull();
    expect(plan.report.blockers).toContain("invalid_source_contract");
    expect(JSON.stringify(plan.report)).not.toContain("do-not-echo");
  });

  it("keeps successful source answers without stored text in the encrypted archive only", async () => {
    const source = sourceArtifacts() as Record<string, Uint8Array>;
    const path = "runs/run-1/answers.jsonl";
    const answer = sourceAnswer();
    delete answer.text;
    delete answer.citations;
    source[path] = bytes(`${JSON.stringify(answer)}\n`);

    const plan = await prepareAutoGeoClientRestore(source, reviewedMapping());

    expect(plan.archiveArtifacts).toEqual(source);
    expect(plan.archive).toBeNull();
    expect(plan.report.unmappedAnswers).toBe(1);
    expect(plan.report.blockers).toContain("unmapped_answer_rows_archived");
  });

  it("maps a failed source answer without fabricating answer text", async () => {
    const source = sourceArtifacts() as Record<string, Uint8Array>;
    const path = "runs/run-1/answers.jsonl";
    const answer = sourceAnswer();
    answer.text = "";
    answer.citations = [];
    answer.status = "error";
    answer.error = "synthetic provider failure";
    answer.cost_usd = 0;
    answer.cost_source = "unreported";
    delete answer.observed_version;
    delete answer.search_executed;
    delete answer.search_executed_evidence;
    delete answer.counts_toward_retrieval_metrics;
    source[path] = bytes(`${JSON.stringify(answer)}\n`);
    const mapping = reviewedMapping();
    mapping.answerMappings["run-1:answer-1"].sourceStatus = "error";
    mapping.answerMappings["run-1:answer-1"].resultStatus = "failed";

    const plan = await prepareAutoGeoClientRestore(source, mapping);

    expect(plan.archive).not.toBeNull();
    const archive = clientRestoreArchiveSchema.parse(plan.archive);
    expect(archive.payload.aiNativeResults[0]).toMatchObject({
      resultStatus: "failed",
      answer: null,
      observedModel: null,
      searchStatus: "unknown",
      errorCode: "historical_source_failure",
    });
  });

  it("preserves private bytes in the archive and never interprets them as import rows", async () => {
    const source = sourceArtifacts() as Record<string, Uint8Array>;
    source["private/client.jsonl"] = bytes("not-json, preserved privately\n");

    const plan = await prepareAutoGeoClientRestore(source, reviewedMapping());

    expect(plan.archiveArtifacts).toEqual(source);
    expect(plan.archive).not.toBeNull();
    expect(plan.report.mappedAnswers).toBe(1);
  });

  it("does not map answers without explicit run, prompt, or collection-time evidence", async () => {
    const mapping = {
      ...reviewedMapping(),
      runMappings: {},
      promptMappings: {},
      answerMappings: {},
    };
    const plan = await prepareAutoGeoClientRestore(sourceArtifacts(), mapping);

    expect(plan.archiveArtifacts).toEqual(sourceArtifacts());
    expect(plan.report.unmappedAnswers).toBe(1);
    expect(plan.archive).toBeNull();
  });

  it("keeps answers with a mismatched prompt locale in the source archive", async () => {
    const source = sourceArtifacts() as Record<string, Uint8Array>;
    const answer = sourceAnswer();
    answer.locale = "mismatched";
    source["runs/run-1/answers.jsonl"] = bytes(`${JSON.stringify(answer)}\n`);

    const plan = await prepareAutoGeoClientRestore(source, reviewedMapping());

    expect(plan.archiveArtifacts).toEqual(source);
    expect(plan.report.unmappedAnswers).toBe(1);
    expect(plan.archive).toBeNull();
  });

  it("does not map an answer when reviewed status contradicts the source", async () => {
    const mapping = reviewedMapping();
    mapping.answerMappings["run-1:answer-1"].resultStatus = "failed";

    const plan = await prepareAutoGeoClientRestore(sourceArtifacts(), mapping);

    expect(plan.report.unmappedAnswers).toBe(1);
    expect(plan.archive).toBeNull();
  });

  it("does not map an answer when the reviewed provider contradicts the source", async () => {
    const mapping = reviewedMapping();
    mapping.answerMappings["run-1:answer-1"].sourceProvider = "provider-b";

    const plan = await prepareAutoGeoClientRestore(sourceArtifacts(), mapping);

    expect(plan.report.unmappedAnswers).toBe(1);
    expect(plan.archive).toBeNull();
  });

  it("rejects answer aliases absent from the pinned producer contract", async () => {
    const source = sourceArtifacts() as Record<string, Uint8Array>;
    const answer = sourceAnswer();
    answer.answer_text = "legacy alias must not be interpreted";
    source["runs/run-1/answers.jsonl"] = bytes(`${JSON.stringify(answer)}\n`);

    const plan = await prepareAutoGeoClientRestore(source, reviewedMapping());

    expect(plan.archiveArtifacts).toEqual(source);
    expect(plan.archive).toBeNull();
    expect(plan.report.blockers).toContain("invalid_source_contract");
  });

  it("rejects active target runs and pending historical answers from import", async () => {
    const original = reviewedMapping();
    const mapping: unknown = {
      ...original,
      runMappings: {
        ...original.runMappings,
        "run-1": { ...original.runMappings["run-1"], status: "running" },
      },
      answerMappings: {
        ...original.answerMappings,
        "run-1:answer-1": {
          ...original.answerMappings["run-1:answer-1"],
          resultStatus: "pending",
        },
      },
    };
    const plan = await prepareAutoGeoClientRestore(sourceArtifacts(), mapping);

    expect(plan.report.unmappedAnswers).toBe(1);
    expect(plan.archive).toBeNull();
    expect(plan.report.blockers).toContain("active_or_unconfirmed_run");
  });
});

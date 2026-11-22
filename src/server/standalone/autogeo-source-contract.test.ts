import { describe, expect, it } from "vitest";
import {
  classifyAutoGeoSourcePaths,
  parseAutoGeoSourceRows,
} from "./autogeo-source-contract";

function bytes(value: string) {
  return new TextEncoder().encode(value);
}

function canonicalArtifacts(runId: string) {
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
    [`runs/${runId}/answers.jsonl`]: bytes(
      `${JSON.stringify({
        answer_id: "A-0001",
        prompt_id: "prompt-1",
        locale: "en",
        provider: "openai",
        retrieval_mode: "retrieval",
        model_id: "gpt-5.5-mini",
        asked_utc: "2026-10-01T10:00:00Z",
        status: "ok",
        attempt: 1,
        text: "A synthetic answer.",
        citations: ["https://example.test/source"],
        cost_usd: 0.001,
        cost_source: "reported",
        observed_version: "gpt-5.5-2026-10",
        search_executed: "executed",
        search_executed_evidence: "synthetic search evidence",
        counts_toward_retrieval_metrics: true,
      })}\n`,
    ),
  } as Record<string, Uint8Array>;
}

describe("AutoGeo source artifact contract", () => {
  it("parses the pinned producer Answer JSONL contract and derives run id from its path", () => {
    const runId = "openai-2026-10-01-1";
    const artifacts = canonicalArtifacts(runId);
    const classified = classifyAutoGeoSourcePaths(Object.keys(artifacts));

    const source = parseAutoGeoSourceRows(artifacts, classified);

    expect(source.runs).toEqual([
      {
        runId,
        rows: [
          expect.objectContaining({
            answer_id: "A-0001",
            prompt_id: "prompt-1",
            provider: "openai",
            locale: "en",
            retrieval_mode: "retrieval",
            model_id: "gpt-5.5-mini",
            asked_utc: "2026-10-01T10:00:00Z",
            status: "ok",
            attempt: 1,
            text: "A synthetic answer.",
            citations: ["https://example.test/source"],
            cost_usd: 0.001,
            cost_source: "reported",
            observed_version: "gpt-5.5-2026-10",
          }),
        ],
      },
    ]);
  });

  it("accepts ephemeral successes without text or citations while retaining their archived source row", () => {
    const artifacts = canonicalArtifacts("openai-2026-10-01-1");
    const path = "runs/openai-2026-10-01-1/answers.jsonl";
    const row: Record<string, unknown> = JSON.parse(
      new TextDecoder().decode(artifacts[path]),
    );
    delete row.text;
    delete row.citations;
    row.privacy_match = true;
    artifacts[path] = bytes(`${JSON.stringify(row)}\n`);

    const source = parseAutoGeoSourceRows(
      artifacts,
      classifyAutoGeoSourcePaths(Object.keys(artifacts)),
    );

    expect(source.runs[0]).toMatchObject({
      runId: "openai-2026-10-01-1",
      rows: [{ answer_id: "A-0001", privacy_match: true }],
    });
    expect(source.runs[0]?.rows[0]).not.toHaveProperty("text");
  });

  it("preserves private source paths for encrypted archive without parsing them", () => {
    const artifacts = {
      ...canonicalArtifacts("openai-2026-10-01-1"),
      "private/consent.json": bytes('{"scope":"private"}\n'),
    };

    const classified = classifyAutoGeoSourcePaths(Object.keys(artifacts));
    const source = parseAutoGeoSourceRows(artifacts, classified);

    expect(classified).toContainEqual({
      path: "private/consent.json",
      kind: "private",
    });
    expect(source.prompts).toHaveLength(1);
    expect(source.runs).toHaveLength(1);
  });
});

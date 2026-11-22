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
        run_id: runId,
        prompt_id: "prompt-1",
        intent_category: "product_research",
        locale: "en",
        provider: "openai",
        model_id: "gpt-5.5-mini",
        model_snapshot_date: "2026-10-01",
        requested_at: "2026-10-01T10:00:00Z",
        status: "ok",
        answer_text: "A synthetic answer.",
        citations: ["https://example.test/source"],
        error: null,
      })}\n`,
    ),
  } as Record<string, Uint8Array>;
}

describe("AutoGeo source artifact contract", () => {
  it("parses the pinned Answer JSONL contract without inventing billing or route fields", () => {
    const runId = "openai-2026-10-01-1";
    const artifacts = canonicalArtifacts(runId);
    const classified = classifyAutoGeoSourcePaths(Object.keys(artifacts));

    const source = parseAutoGeoSourceRows(artifacts, classified);

    expect(source.runs).toEqual([
      {
        runId,
        rows: [
          {
            answer_id: "A-0001",
            run_id: runId,
            prompt_id: "prompt-1",
            intent_category: "product_research",
            locale: "en",
            provider: "openai",
            model_id: "gpt-5.5-mini",
            model_snapshot_date: "2026-10-01",
            requested_at: "2026-10-01T10:00:00Z",
            status: "ok",
            answer_text: "A synthetic answer.",
            citations: ["https://example.test/source"],
            error: null,
          },
        ],
      },
    ]);
  });

  it("rejects an Answer whose embedded run id differs from its artifact path", () => {
    const artifacts = canonicalArtifacts("openai-2026-10-01-1");
    const path = "runs/openai-2026-10-01-1/answers.jsonl";
    const row: unknown = JSON.parse(new TextDecoder().decode(artifacts[path]));
    if (
      typeof row !== "object" ||
      row === null ||
      Array.isArray(row) ||
      !("run_id" in row)
    ) {
      throw new Error("expected a source answer object");
    }
    row.run_id = "openai-2026-10-02-1";
    artifacts[path] = bytes(`${JSON.stringify(row)}\n`);
    const classified = classifyAutoGeoSourcePaths(Object.keys(artifacts));

    expect(() => parseAutoGeoSourceRows(artifacts, classified)).toThrow(
      "invalid_source_contract",
    );
  });
});

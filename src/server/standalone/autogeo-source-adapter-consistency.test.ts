import { describe, expect, it } from "vitest";
import { prepareAutoGeoClientRestore } from "./autogeo-source-adapter";
import {
  reviewedMapping,
  syntheticSourceArtifacts,
} from "./autogeo-source-migration.test-fixtures";

describe("AutoGeo source answer mapping consistency", () => {
  it("keeps an answer with a mismatched intent category in the source archive", async () => {
    const source = syntheticSourceArtifacts();
    const path = "runs/run-auto-1/answers.jsonl";
    const answer: unknown = JSON.parse(new TextDecoder().decode(source[path]));
    if (
      typeof answer !== "object" ||
      answer === null ||
      Array.isArray(answer) ||
      !("intent_category" in answer)
    ) {
      throw new Error("expected a source answer object");
    }
    answer.intent_category = "unrelated_category";
    source[path] = new TextEncoder().encode(`${JSON.stringify(answer)}\n`);

    const plan = await prepareAutoGeoClientRestore(source, reviewedMapping());

    expect(plan.archiveArtifacts).toEqual(source);
    expect(plan.report.unmappedAnswers).toBe(1);
    expect(plan.archive).toBeNull();
    expect(plan.report.blockers).toContain(
      "reviewed_answer_mapping_missing_or_incompatible",
    );
  });
});

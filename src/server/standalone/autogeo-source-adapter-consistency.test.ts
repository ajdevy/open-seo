import { describe, expect, it } from "vitest";
import { prepareAutoGeoClientRestore } from "./autogeo-source-adapter";
import {
  reviewedMapping,
  syntheticSourceArtifacts,
} from "./autogeo-source-migration.test-fixtures";

describe("AutoGeo source answer mapping consistency", () => {
  it("derives intent from the uniquely matched prompt matrix row", async () => {
    const source = syntheticSourceArtifacts();

    const plan = await prepareAutoGeoClientRestore(source, reviewedMapping());

    expect(plan.archiveArtifacts).toEqual(source);
    expect(plan.report.mappedAnswers).toBe(1);
    expect(plan.report.unmappedAnswers).toBe(0);
    expect(plan.archive).not.toBeNull();
  });
});

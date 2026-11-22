import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { projects } from "@/db/schema";

const { testDb } = await vi.hoisted(async () => {
  const { createAiVisibilityTestDb } =
    await import("@/server/features/ai-visibility/aiVisibilityTestDb");
  return { testDb: await createAiVisibilityTestDb() };
});

vi.mock("cloudflare:workers", () => ({
  env: { DATABASE_PROVIDER: "d1" },
  waitUntil: vi.fn(),
}));
vi.mock("@/db", () => ({ db: testDb.db }));
vi.mock("@/db/runBatch", () => ({ runBatch: testDb.runBatch }));

import { seedClientRows } from "./client-restore-fixtures";
import { importClientRestoreArchive } from "./client-restore-import";
import { prepareAutoGeoClientRestore } from "./autogeo-source-adapter";
import {
  syntheticSourceArtifacts,
  reviewedMapping,
} from "./autogeo-source-migration.test-fixtures";

describe("AutoGeo source restore integration", () => {
  beforeEach(() => seedClientRows(testDb));
  afterAll(() => testDb.client.close());

  it("reimports reviewed synthetic history idempotently without changing another client", async () => {
    const plan = await prepareAutoGeoClientRestore(
      syntheticSourceArtifacts(),
      reviewedMapping(),
    );
    expect(plan.report.blockers).toEqual([]);
    expect(plan.archive).not.toBeNull();
    if (!plan.archive) throw new Error("synthetic restore archive unavailable");

    const clientBBefore = await testDb.db
      .select()
      .from(projects)
      .where(eq(projects.organizationId, "client-b"));
    const first = await importClientRestoreArchive("target-a", plan.archive);
    const second = await importClientRestoreArchive("target-a", plan.archive);
    const clientBAfter = await testDb.db
      .select()
      .from(projects)
      .where(eq(projects.organizationId, "client-b"));

    expect(first.verified).toBe(true);
    expect(second.verified).toBe(true);
    expect(second.importedProjectIds).toEqual(first.importedProjectIds);
    expect(clientBAfter).toEqual(clientBBefore);
  });
});

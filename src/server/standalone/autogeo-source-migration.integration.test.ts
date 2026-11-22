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
import { runAutoGeoSourceMigration } from "./autogeo-source-migration";
import {
  migrationHarness,
  reviewedMapping,
  syntheticSourceArtifacts,
  jsonlBytes,
} from "./autogeo-source-migration.test-fixtures";

const testNow = () => new Date("2026-11-22T10:00:00.000Z");

describe("AutoGeo source migration orchestration", () => {
  beforeEach(() => seedClientRows(testDb));
  afterAll(() => testDb.client.close());

  it("persists and reads back the encrypted source before an idempotent import", async () => {
    const mapping = reviewedMapping();
    const harness = migrationHarness();
    const archiveKey = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    const clientBBefore = await testDb.db
      .select()
      .from(projects)
      .where(eq(projects.organizationId, "client-b"));
    const run = () =>
      runAutoGeoSourceMigration(
        {
          targetOrganizationId: "target-a",
          idempotencyKey: "synthetic-migration-1",
          mapping,
          authorization: harness.authorization,
          outbox: harness.outbox,
          archiveKey,
          archivePort: harness.archive,
          async readSourceArtifacts() {
            harness.events.push("source-read");
            return syntheticSourceArtifacts();
          },
        },
        testNow,
      );

    const first = await run();
    const second = await run();
    const clientBAfter = await testDb.db
      .select()
      .from(projects)
      .where(eq(projects.organizationId, "client-b"));

    expect(first.status).toBe("imported");
    expect(second.status).toBe("imported");
    if (first.status !== "imported" || second.status !== "imported")
      throw new Error("synthetic migration did not complete");
    expect(second.importedProjectIds).toEqual(first.importedProjectIds);
    expect(second.importedContentSha256).toBe(first.importedContentSha256);
    expect(clientBAfter).toEqual(clientBBefore);
    expect(harness.outboxRecords.size).toBe(1);
    expect(harness.remoteArchives.size).toBe(1);
    expect(harness.events.indexOf("authorization")).toBeLessThan(
      harness.events.indexOf("source-read"),
    );
    expect(harness.events.indexOf("outbox-persist")).toBeLessThan(
      harness.events.indexOf("drive-write"),
    );
    expect(harness.events.indexOf("drive-readback")).toBeGreaterThan(
      harness.events.indexOf("drive-write"),
    );
  });

  it("does not read source or archive when per-client authorization is denied", async () => {
    const harness = migrationHarness({ deny: true });
    const archiveKey = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    let sourceReads = 0;
    const result = await runAutoGeoSourceMigration(
      {
        targetOrganizationId: "target-a",
        idempotencyKey: "synthetic-denied-migration",
        mapping: reviewedMapping(),
        authorization: harness.authorization,
        outbox: harness.outbox,
        archiveKey,
        archivePort: harness.archive,
        async readSourceArtifacts() {
          sourceReads += 1;
          return syntheticSourceArtifacts();
        },
      },
      testNow,
    );

    expect(result).toEqual({
      status: "blocked",
      reason: "authorization_required",
    });
    expect(sourceReads).toBe(0);
    expect(harness.outboxRecords.size).toBe(0);
    expect(harness.remoteArchives.size).toBe(0);
  });

  it("does not read source when the approval has expired", async () => {
    const harness = migrationHarness({ expiredApproval: true });
    const archiveKey = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    let sourceReads = 0;
    const result = await runAutoGeoSourceMigration(
      {
        targetOrganizationId: "target-a",
        idempotencyKey: "synthetic-expired-migration",
        mapping: reviewedMapping(),
        authorization: harness.authorization,
        outbox: harness.outbox,
        archiveKey,
        archivePort: harness.archive,
        async readSourceArtifacts() {
          sourceReads += 1;
          return syntheticSourceArtifacts();
        },
      },
      testNow,
    );

    expect(result).toEqual({
      status: "blocked",
      reason: "authorization_required",
    });
    expect(sourceReads).toBe(0);
    expect(harness.outboxRecords.size).toBe(0);
  });

  it("does not import unless encrypted Drive read-back succeeds", async () => {
    const harness = migrationHarness({ failDriveWrite: true });
    const archiveKey = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    const targetProjectsBefore = await testDb.db
      .select()
      .from(projects)
      .where(eq(projects.organizationId, "target-a"));
    const result = await runAutoGeoSourceMigration(
      {
        targetOrganizationId: "target-a",
        idempotencyKey: "synthetic-pending-migration",
        mapping: reviewedMapping(),
        authorization: harness.authorization,
        outbox: harness.outbox,
        archiveKey,
        archivePort: harness.archive,
        async readSourceArtifacts() {
          return syntheticSourceArtifacts();
        },
      },
      testNow,
    );
    const targetProjectsAfter = await testDb.db
      .select()
      .from(projects)
      .where(eq(projects.organizationId, "target-a"));

    expect(result).toMatchObject({
      status: "archive_pending",
      reason: "drive_write_unconfirmed",
    });
    expect(targetProjectsAfter).toEqual(targetProjectsBefore);
  });

  it("archives an incomplete mapping without importing partial source rows", async () => {
    const mapping = reviewedMapping();
    mapping.answerMappings = {};
    const harness = migrationHarness();
    const archiveKey = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    const targetProjectsBefore = await testDb.db
      .select()
      .from(projects)
      .where(eq(projects.organizationId, "target-a"));

    const result = await runAutoGeoSourceMigration(
      {
        targetOrganizationId: "target-a",
        idempotencyKey: "synthetic-incomplete-mapping",
        mapping,
        authorization: harness.authorization,
        outbox: harness.outbox,
        archiveKey,
        archivePort: harness.archive,
        async readSourceArtifacts() {
          return syntheticSourceArtifacts();
        },
      },
      testNow,
    );
    const targetProjectsAfter = await testDb.db
      .select()
      .from(projects)
      .where(eq(projects.organizationId, "target-a"));

    expect(result).toMatchObject({
      status: "archived_unimported",
      reason: "incomplete_source_mapping",
      report: { unmappedAnswers: 1 },
    });
    expect(harness.outboxRecords.size).toBe(1);
    expect(harness.remoteArchives.size).toBe(1);
    expect(targetProjectsAfter).toEqual(targetProjectsBefore);
  });

  it("rejects changed source bytes when an idempotency key already has an outbox record", async () => {
    const mapping = reviewedMapping();
    const harness = migrationHarness();
    const archiveKey = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    const artifacts = syntheticSourceArtifacts();
    const run = () =>
      runAutoGeoSourceMigration(
        {
          targetOrganizationId: "target-a",
          idempotencyKey: "synthetic-conflicting-migration",
          mapping,
          authorization: harness.authorization,
          outbox: harness.outbox,
          archiveKey,
          archivePort: harness.archive,
          async readSourceArtifacts() {
            return artifacts;
          },
        },
        testNow,
      );

    const first = await run();
    expect(first.status).toBe("imported");
    const targetAfterFirst = await testDb.db
      .select()
      .from(projects)
      .where(eq(projects.organizationId, "target-a"));
    artifacts["runs/run-auto-1/answers.jsonl"] = jsonlBytes({
      answer_id: "answer-auto-1",
      run_id: "run-auto-1",
      prompt_id: "prompt-auto-1",
      intent_category: "product_research",
      locale: "en",
      provider: "provider-a",
      model_id: "model-a",
      model_snapshot_date: "2026-10-01",
      requested_at: "2026-10-01T10:00:00.000Z",
      status: "ok",
      answer_text: "Changed synthetic source bytes.",
      citations: ["https://example.test/source"],
      error: null,
    });

    const second = await run();
    const targetAfterSecond = await testDb.db
      .select()
      .from(projects)
      .where(eq(projects.organizationId, "target-a"));

    expect(second).toMatchObject({
      status: "archive_pending",
      reason: "outbox_unconfirmed",
    });
    expect(
      harness.events.filter((event) => event === "drive-write"),
    ).toHaveLength(1);
    expect(targetAfterSecond).toEqual(targetAfterFirst);
  });
});

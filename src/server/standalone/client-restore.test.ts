import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { z } from "zod";
import {
  aiNativeResults,
  aiObservations,
  aiPrompts,
  aiRuns,
  aiSources,
  aiTrackers,
  member,
  projects,
} from "@/db/schema";

const { testDb, operatorSecret } = await vi.hoisted(async () => {
  const { createAiVisibilityTestDb } =
    await import("@/server/features/ai-visibility/aiVisibilityTestDb");
  return {
    testDb: await createAiVisibilityTestDb(),
    operatorSecret: "o".repeat(32),
  };
});

vi.mock("cloudflare:workers", () => ({
  env: {
    DATABASE_PROVIDER: "d1",
    OPENSEO_OPERATOR_SECRET: operatorSecret,
  },
  waitUntil: vi.fn(),
}));
vi.mock("@/db", () => ({ db: testDb.db }));
vi.mock("@/db/runBatch", () => ({
  runBatch: testDb.runBatch,
}));

import { seedClientRows } from "./client-restore-fixtures";
import { handleClientRestore } from "./client-restore";
import { clientRestoreArchiveSchema } from "./client-restore-schema";

const importResultSchema = z.object({
  verified: z.boolean(),
  importedProjectIds: z.array(z.string()),
  recovery: z.object({
    activeRunsClosed: z.number(),
    unconfirmedObservationsNotReplayed: z.number(),
    unconfirmedNativeResultsNotReplayed: z.number(),
  }),
});

async function postRestore(
  body: unknown,
  { authorized = true }: { authorized?: boolean } = {},
) {
  const headers = new Headers({ "content-type": "application/json" });
  if (authorized) headers.set("x-openseo-operator-secret", operatorSecret);
  return handleClientRestore(
    new Request("http://localhost/api/standalone/client-restore", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
  );
}

async function exportArchive() {
  const response = await postRestore({
    command: "export",
    organizationId: "organization",
  });
  expect(response.status).toBe(200);
  return clientRestoreArchiveSchema.parse(await response.json());
}

beforeEach(async () => {
  await seedClientRows(testDb);
});
afterAll(() => testDb.client.close());

describe("selective client restore", () => {
  it("keeps the client restore endpoint hidden without the operator secret", async () => {
    const response = await postRestore(
      { command: "export", organizationId: "organization" },
      { authorized: false },
    );
    expect(response.status).toBe(404);
  });

  it("imports Client A twice with question versions and answers while preserving Client B and all memberships", async () => {
    const archive = await exportArchive();
    const bProjectBefore = await testDb.db
      .select()
      .from(projects)
      .where(eq(projects.id, "project-b"));
    const bMembersBefore = await testDb.db
      .select()
      .from(member)
      .where(eq(member.organizationId, "client-b"));
    const targetMembersBefore = await testDb.db
      .select()
      .from(member)
      .where(eq(member.organizationId, "target-a"));

    const firstResponse = await postRestore({
      command: "import",
      targetOrganizationId: "target-a",
      archive,
    });
    const first = importResultSchema.parse(await firstResponse.json());
    const secondResponse = await postRestore({
      command: "import",
      targetOrganizationId: "target-a",
      archive,
    });
    const second = importResultSchema.parse(await secondResponse.json());
    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);

    expect(first.verified).toBe(true);
    expect(second.importedProjectIds).toEqual(first.importedProjectIds);
    expect(first.recovery).toEqual({
      activeRunsClosed: 1,
      unconfirmedObservationsNotReplayed: 1,
      unconfirmedNativeResultsNotReplayed: 1,
    });
    const importedProjectId = first.importedProjectIds[0];
    const importedProject = await testDb.db
      .select()
      .from(projects)
      .where(eq(projects.id, importedProjectId));
    expect(importedProject[0]).toMatchObject({
      organizationId: "target-a",
      name: "Client A",
      domain: "client-a.example",
    });

    const importedPrompts = await testDb.db
      .select()
      .from(aiPrompts)
      .innerJoin(aiTrackers, eq(aiPrompts.trackerId, aiTrackers.id))
      .where(eq(aiTrackers.projectId, importedProjectId));
    expect(
      new Set(importedPrompts.map(({ ai_prompts: prompt }) => prompt.text)),
    ).toEqual(
      new Set([
        "What is the latest question version for Client A?",
        "Which tool should Client A evaluate?",
      ]),
    );
    const importedAnswer = await testDb.db
      .select()
      .from(aiObservations)
      .innerJoin(aiRuns, eq(aiObservations.runId, aiRuns.id))
      .where(eq(aiRuns.projectId, importedProjectId));
    expect(
      importedAnswer.some(
        ({ ai_observations: observation }) =>
          observation.answerMarkdown === "Client A synthetic answer.",
      ),
    ).toBe(true);
    const importedSource = await testDb.db
      .select()
      .from(aiSources)
      .innerJoin(aiObservations, eq(aiSources.observationId, aiObservations.id))
      .innerJoin(aiRuns, eq(aiObservations.runId, aiRuns.id))
      .where(eq(aiRuns.projectId, importedProjectId));
    expect(importedSource[0]?.ai_sources.url).toBe(
      "https://client-a.example/source",
    );
    const nativePending = await testDb.db
      .select()
      .from(aiNativeResults)
      .where(eq(aiNativeResults.projectId, importedProjectId));
    expect(
      nativePending.find((row) => row.resultStatus === "failed"),
    ).toMatchObject({
      answer: null,
      errorCode: "restore_unknown_not_replayed",
      finalizationToken: null,
    });
    expect(nativePending.every((row) => row.finalizationToken === null)).toBe(
      true,
    );

    expect(
      await testDb.db
        .select()
        .from(projects)
        .where(eq(projects.id, "project-b")),
    ).toEqual(bProjectBefore);
    expect(
      await testDb.db
        .select()
        .from(member)
        .where(eq(member.organizationId, "client-b")),
    ).toEqual(bMembersBefore);
    expect(
      await testDb.db
        .select()
        .from(member)
        .where(eq(member.organizationId, "target-a")),
    ).toEqual(targetMembersBefore);
    expect(
      await testDb.db
        .select()
        .from(projects)
        .where(eq(projects.organizationId, "target-a")),
    ).toHaveLength(2);
  });

  it("rejects a damaged archive before it writes any project", async () => {
    const archive = await exportArchive();
    archive.payload.projects[0].name = "tampered client";
    const response = await postRestore({
      command: "import",
      targetOrganizationId: "target-a",
      archive,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "Client restore checksum mismatch",
    });
    expect(
      await testDb.db
        .select()
        .from(projects)
        .where(eq(projects.organizationId, "target-a")),
    ).toHaveLength(1);
  });

  it("rejects a row that crosses the source client boundary even with a valid checksum", async () => {
    const archive = await exportArchive();
    const { payload } = archive;
    payload.projects.push({
      ...payload.projects[0],
      id: "project-b",
      organizationId: "client-b",
    });
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    archive.contentSha256 = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    const response = await postRestore({
      command: "import",
      targetOrganizationId: "target-a",
      archive,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "Snapshot contains a project from another client",
    });
    expect(
      await testDb.db
        .select()
        .from(projects)
        .where(eq(projects.organizationId, "target-a")),
    ).toHaveLength(1);
  });
});

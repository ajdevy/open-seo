import { eq } from "drizzle-orm";
import { db } from "@/db";
import {
  aiMatches,
  aiNativeResults,
  aiNativeSearchEvidence,
  aiNativeSearchSources,
  aiNativeSources,
  aiObservations,
  aiPrompts,
  aiRuns,
  aiSources,
  aiTrackers,
  organization,
  projectCompetitors,
  projectContextSections,
  projectKeyPages,
  projectResearchLog,
  projects,
} from "@/db/schema";
import { runBatch } from "@/db/runBatch";
import {
  ClientRestoreError,
  clientRestoreArchiveSchema,
  sha256Json,
  type ClientRestorePayload,
} from "./client-restore-schema";
import { loadPayload } from "./client-restore-export";
import { remapPayload } from "./client-restore-remap";
import { validatePayload } from "./client-restore-validate";

const WRITE_CHUNK_SIZE = 100;
type Executor = Parameters<Parameters<typeof runBatch>[0]>[0];

async function insertRows<T>(
  rows: T[],
  build: (executor: Executor, row: T) => Promise<unknown>,
) {
  for (let offset = 0; offset < rows.length; offset += WRITE_CHUNK_SIZE) {
    const chunk = rows.slice(offset, offset + WRITE_CHUNK_SIZE);
    await runBatch((executor) => chunk.map((row) => build(executor, row)));
  }
}

async function insertPayload(payload: ClientRestorePayload) {
  await insertRows(payload.projects, (tx, row) =>
    tx.insert(projects).values(row).onConflictDoNothing(),
  );
  await insertRows(payload.projectContextSections, (tx, row) =>
    tx.insert(projectContextSections).values(row).onConflictDoNothing(),
  );
  await insertRows(payload.projectCompetitors, (tx, row) =>
    tx.insert(projectCompetitors).values(row).onConflictDoNothing(),
  );
  await insertRows(payload.projectKeyPages, (tx, row) =>
    tx.insert(projectKeyPages).values(row).onConflictDoNothing(),
  );
  await insertRows(payload.projectResearchLog, (tx, row) =>
    tx.insert(projectResearchLog).values(row).onConflictDoNothing(),
  );
  await insertRows(payload.aiTrackers, (tx, row) =>
    tx.insert(aiTrackers).values(row).onConflictDoNothing(),
  );
  await insertRows(payload.aiPrompts, (tx, row) =>
    tx.insert(aiPrompts).values(row).onConflictDoNothing(),
  );
  await insertRows(payload.aiRuns, (tx, row) =>
    tx.insert(aiRuns).values(row).onConflictDoNothing(),
  );
  await insertRows(payload.aiObservations, (tx, row) =>
    tx.insert(aiObservations).values(row).onConflictDoNothing(),
  );
  await insertRows(payload.aiSources, (tx, row) =>
    tx.insert(aiSources).values(row).onConflictDoNothing(),
  );
  await insertRows(payload.aiMatches, (tx, row) =>
    tx.insert(aiMatches).values(row).onConflictDoNothing(),
  );
  await insertRows(payload.aiNativeResults, (tx, row) =>
    tx.insert(aiNativeResults).values(row).onConflictDoNothing(),
  );
  await insertRows(payload.aiNativeSources, (tx, row) =>
    tx.insert(aiNativeSources).values(row).onConflictDoNothing(),
  );
  await insertRows(payload.aiNativeSearchSources, (tx, row) =>
    tx.insert(aiNativeSearchSources).values(row).onConflictDoNothing(),
  );
  await insertRows(payload.aiNativeSearchEvidence, (tx, row) =>
    tx.insert(aiNativeSearchEvidence).values(row).onConflictDoNothing(),
  );
}

function rowCounts(payload: ClientRestorePayload) {
  return {
    projects: payload.projects.length,
    projectContextSections: payload.projectContextSections.length,
    projectCompetitors: payload.projectCompetitors.length,
    projectKeyPages: payload.projectKeyPages.length,
    projectResearchLog: payload.projectResearchLog.length,
    aiTrackers: payload.aiTrackers.length,
    aiPrompts: payload.aiPrompts.length,
    aiRuns: payload.aiRuns.length,
    aiObservations: payload.aiObservations.length,
    aiSources: payload.aiSources.length,
    aiMatches: payload.aiMatches.length,
    aiNativeResults: payload.aiNativeResults.length,
    aiNativeSources: payload.aiNativeSources.length,
    aiNativeSearchSources: payload.aiNativeSearchSources.length,
    aiNativeSearchEvidence: payload.aiNativeSearchEvidence.length,
  };
}

export async function importClientRestoreArchive(
  targetOrganizationId: string,
  rawArchive: unknown,
) {
  const parsed = clientRestoreArchiveSchema.safeParse(rawArchive);
  if (!parsed.success)
    throw new ClientRestoreError(400, "Invalid client restore archive");
  const archive = parsed.data;
  if (archive.payload.projects.length === 0)
    throw new ClientRestoreError(400, "Client restore archive has no projects");
  if ((await sha256Json(archive.payload)) !== archive.contentSha256)
    throw new ClientRestoreError(400, "Client restore checksum mismatch");
  validatePayload(archive.payload);
  const [target] = await db
    .select({ id: organization.id })
    .from(organization)
    .where(eq(organization.id, targetOrganizationId))
    .limit(1);
  if (!target)
    throw new ClientRestoreError(404, "Target client does not exist");

  const remapped = await remapPayload(
    archive.payload,
    targetOrganizationId,
    archive.contentSha256,
  );
  await insertPayload(remapped);

  // Read the imported project IDs back and compare every accepted row, including
  // question text, result versions and ordered sources. This also turns a
  // partially applied chunked import into a visible failure; re-running the same
  // archive is safe because IDs are deterministic and writes never overwrite.
  const importedProjectIds = remapped.projects.map((row) => row.id);
  const verified = await loadPayload(targetOrganizationId, importedProjectIds);
  const expectedHash = await sha256Json(remapped);
  const verifiedHash = await sha256Json(verified);
  if (expectedHash !== verifiedHash)
    throw new ClientRestoreError(
      409,
      "Client restore is incomplete; rerun the same archive and verify before cutover",
    );
  return {
    contentSha256: archive.contentSha256,
    importedContentSha256: verifiedHash,
    importedProjectIds,
    rowCounts: rowCounts(remapped),
    recovery: archive.recovery,
    verified: true,
  };
}

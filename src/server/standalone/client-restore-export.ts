import { and, eq, inArray } from "drizzle-orm";
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
  projectCompetitors,
  projectContextSections,
  projectKeyPages,
  projectResearchLog,
  projects,
} from "@/db/schema";
import {
  ClientRestoreError,
  clientRestoreArchiveSchema,
  ids,
  ordered,
  payloadSchema,
  relationKey,
  sha256Json,
  type ClientRestorePayload,
} from "./client-restore-schema";
import { validatePayload } from "./client-restore-validate";

const UNCONFIRMED_RESTORE_ERROR = "restore_unknown_not_replayed";
const emptyRows = <T>(): Promise<T[]> => Promise.resolve([] as T[]);

export async function loadPayload(
  organizationId: string,
  onlyProjectIds?: string[],
): Promise<ClientRestorePayload> {
  const projectFilter = onlyProjectIds?.length
    ? and(
        eq(projects.organizationId, organizationId),
        inArray(projects.id, onlyProjectIds),
      )
    : eq(projects.organizationId, organizationId);
  const projectRows = ordered(
    await db.select().from(projects).where(projectFilter),
    (row) => row.id,
  );
  const projectIds = ids(projectRows, (row) => row.id);
  const [contextRows, competitorRows, keyPageRows, researchRows, trackerRows] =
    projectIds.length
      ? await Promise.all([
          db
            .select()
            .from(projectContextSections)
            .where(inArray(projectContextSections.projectId, projectIds)),
          db
            .select()
            .from(projectCompetitors)
            .where(inArray(projectCompetitors.projectId, projectIds)),
          db
            .select()
            .from(projectKeyPages)
            .where(inArray(projectKeyPages.projectId, projectIds)),
          db
            .select()
            .from(projectResearchLog)
            .where(inArray(projectResearchLog.projectId, projectIds)),
          db
            .select()
            .from(aiTrackers)
            .where(inArray(aiTrackers.projectId, projectIds)),
        ])
      : await Promise.all([
          emptyRows<ClientRestorePayload["projectContextSections"][number]>(),
          emptyRows<ClientRestorePayload["projectCompetitors"][number]>(),
          emptyRows<ClientRestorePayload["projectKeyPages"][number]>(),
          emptyRows<ClientRestorePayload["projectResearchLog"][number]>(),
          emptyRows<ClientRestorePayload["aiTrackers"][number]>(),
        ]);
  const trackerIds = ids(trackerRows, (row) => row.id);
  const runRowsRaw = projectIds.length
    ? await db
        .select()
        .from(aiRuns)
        .where(inArray(aiRuns.projectId, projectIds))
    : [];
  const runIds = ids(runRowsRaw, (row) => row.id);
  const promptRows = trackerIds.length
    ? await db
        .select()
        .from(aiPrompts)
        .where(inArray(aiPrompts.trackerId, trackerIds))
    : [];
  const observationRowsRaw = runIds.length
    ? await db
        .select()
        .from(aiObservations)
        .where(inArray(aiObservations.runId, runIds))
    : [];
  const nativeRowsRaw = projectIds.length
    ? await db
        .select()
        .from(aiNativeResults)
        .where(inArray(aiNativeResults.projectId, projectIds))
    : [];

  const activeRunIds = new Set(
    runRowsRaw
      .filter((row) => row.status === "queued" || row.status === "running")
      .map((row) => row.id),
  );
  const confirmedRunIds = new Set([
    ...observationRowsRaw
      .filter((row) => row.status === "completed")
      .map((row) => row.runId),
    ...nativeRowsRaw
      .filter((row) => row.resultStatus !== "pending")
      .map((row) => row.runId),
  ]);
  const latestKnownRunEvent = new Map<string, string>();
  for (const row of observationRowsRaw)
    if (row.status === "completed" && row.collectedAt)
      latestKnownRunEvent.set(
        row.runId,
        maxIso(latestKnownRunEvent.get(row.runId), row.collectedAt),
      );
  for (const row of nativeRowsRaw)
    if (row.resultStatus !== "pending")
      latestKnownRunEvent.set(
        row.runId,
        maxIso(latestKnownRunEvent.get(row.runId), row.collectedAt),
      );

  const runRows = runRowsRaw.map((row) =>
    activeRunIds.has(row.id)
      ? {
          ...row,
          status: confirmedRunIds.has(row.id)
            ? ("partial" as const)
            : ("failed" as const),
          // Closing a run at its last durable event prevents an unknown paid call
          // from being presented as active or automatically replayed.
          completedAt: latestKnownRunEvent.get(row.id) ?? row.createdAt,
        }
      : row,
  );
  const observationRows = observationRowsRaw.map((row) =>
    row.status === "pending"
      ? {
          ...row,
          status: "failed" as const,
          collectedAt: null,
          answerMarkdown: null,
          error: UNCONFIRMED_RESTORE_ERROR,
        }
      : row,
  );
  const nativeRows = nativeRowsRaw.map((row) =>
    row.resultStatus === "pending"
      ? {
          ...row,
          resultStatus: "failed",
          answer: null,
          searchStatus: "failed",
          eligibleForVisibility: false,
          errorCode: UNCONFIRMED_RESTORE_ERROR,
          turnStatus: UNCONFIRMED_RESTORE_ERROR,
          finalizationToken: null,
        }
      : { ...row, finalizationToken: null },
  );
  const observationIds = ids(observationRows, (row) => row.id);
  const nativeIds = ids(nativeRows, (row) => row.id);
  const [
    sourceRows,
    matchRows,
    nativeSourceRows,
    nativeSearchSourceRows,
    nativeEvidenceRows,
  ] = await Promise.all([
    observationIds.length
      ? db
          .select()
          .from(aiSources)
          .where(inArray(aiSources.observationId, observationIds))
      : emptyRows<ClientRestorePayload["aiSources"][number]>(),
    observationIds.length
      ? db
          .select()
          .from(aiMatches)
          .where(inArray(aiMatches.observationId, observationIds))
      : emptyRows<ClientRestorePayload["aiMatches"][number]>(),
    nativeIds.length
      ? db
          .select()
          .from(aiNativeSources)
          .where(inArray(aiNativeSources.resultId, nativeIds))
      : emptyRows<ClientRestorePayload["aiNativeSources"][number]>(),
    nativeIds.length
      ? db
          .select()
          .from(aiNativeSearchSources)
          .where(inArray(aiNativeSearchSources.resultId, nativeIds))
      : emptyRows<ClientRestorePayload["aiNativeSearchSources"][number]>(),
    nativeIds.length
      ? db
          .select()
          .from(aiNativeSearchEvidence)
          .where(inArray(aiNativeSearchEvidence.resultId, nativeIds))
      : emptyRows<ClientRestorePayload["aiNativeSearchEvidence"][number]>(),
  ]);
  const confirmedObservationIds = new Set(
    observationRowsRaw
      .filter((row) => row.status !== "pending")
      .map((row) => row.id),
  );
  const confirmedNativeIds = new Set(
    nativeRowsRaw
      .filter((row) => row.resultStatus !== "pending")
      .map((row) => row.id),
  );

  const payload = payloadSchema.parse({
    sourceOrganizationId: organizationId,
    projects: projectRows,
    projectContextSections: contextRows,
    projectCompetitors: competitorRows,
    projectKeyPages: keyPageRows,
    projectResearchLog: researchRows,
    aiTrackers: trackerRows,
    aiPrompts: promptRows,
    aiRuns: runRows,
    aiObservations: observationRows,
    aiSources: sourceRows.filter((row) =>
      confirmedObservationIds.has(row.observationId),
    ),
    aiMatches: matchRows.filter((row) =>
      confirmedObservationIds.has(row.observationId),
    ),
    aiNativeResults: nativeRows,
    aiNativeSources: nativeSourceRows.filter((row) =>
      confirmedNativeIds.has(row.resultId),
    ),
    aiNativeSearchSources: nativeSearchSourceRows.filter((row) =>
      confirmedNativeIds.has(row.resultId),
    ),
    aiNativeSearchEvidence: nativeEvidenceRows.filter((row) =>
      confirmedNativeIds.has(row.resultId),
    ),
  });
  validatePayload(payload);
  return {
    ...payload,
    projects: ordered(payload.projects, (row) => row.id),
    projectContextSections: ordered(
      payload.projectContextSections,
      relationKey,
    ),
    projectCompetitors: ordered(payload.projectCompetitors, relationKey),
    projectKeyPages: ordered(payload.projectKeyPages, relationKey),
    projectResearchLog: ordered(payload.projectResearchLog, relationKey),
    aiTrackers: ordered(payload.aiTrackers, (row) => row.id),
    aiPrompts: ordered(payload.aiPrompts, (row) => row.id),
    aiRuns: ordered(payload.aiRuns, (row) => row.id),
    aiObservations: ordered(payload.aiObservations, (row) => row.id),
    aiSources: ordered(payload.aiSources, (row) => row.id),
    aiMatches: ordered(payload.aiMatches, (row) => row.id),
    aiNativeResults: ordered(payload.aiNativeResults, (row) => row.id),
    aiNativeSources: ordered(payload.aiNativeSources, (row) => row.id),
    aiNativeSearchSources: ordered(
      payload.aiNativeSearchSources,
      (row) => row.id,
    ),
    aiNativeSearchEvidence: ordered(
      payload.aiNativeSearchEvidence,
      (row) => row.id,
    ),
  };
}

function maxIso(current: string | undefined, candidate: string): string {
  return !current || candidate.localeCompare(current) > 0 ? candidate : current;
}

export async function exportClientRestoreArchive(organizationId: string) {
  const payload = await loadPayload(organizationId);
  if (payload.projects.length === 0)
    throw new ClientRestoreError(404, "Client has no projects to export");
  const rawRuns = await db
    .select({ id: aiRuns.id, status: aiRuns.status })
    .from(aiRuns)
    .innerJoin(projects, eq(aiRuns.projectId, projects.id))
    .where(eq(projects.organizationId, organizationId));
  const rawObservations = await db
    .select({ status: aiObservations.status })
    .from(aiObservations)
    .innerJoin(aiRuns, eq(aiObservations.runId, aiRuns.id))
    .innerJoin(projects, eq(aiRuns.projectId, projects.id))
    .where(eq(projects.organizationId, organizationId));
  const rawNative = await db
    .select({ resultStatus: aiNativeResults.resultStatus })
    .from(aiNativeResults)
    .innerJoin(projects, eq(aiNativeResults.projectId, projects.id))
    .where(eq(projects.organizationId, organizationId));
  const archiveWithoutHash = {
    format: "openseo-client-restore" as const,
    version: 1 as const,
    exportedAt: new Date().toISOString(),
    recovery: {
      activeRunsClosed: rawRuns.filter(
        (row) => row.status === "queued" || row.status === "running",
      ).length,
      unconfirmedObservationsNotReplayed: rawObservations.filter(
        (row) => row.status === "pending",
      ).length,
      unconfirmedNativeResultsNotReplayed: rawNative.filter(
        (row) => row.resultStatus === "pending",
      ).length,
    },
    payload,
  };
  const archive = clientRestoreArchiveSchema.parse({
    ...archiveWithoutHash,
    contentSha256: await sha256Json(payload),
  });
  return archive;
}

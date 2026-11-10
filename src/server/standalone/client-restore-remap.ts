import {
  ClientRestoreError,
  ordered,
  relationKey,
  sha256Json,
  type ClientRestorePayload,
} from "./client-restore-schema";

function uuidFromHex(hex: string): string {
  const digits = hex.slice(0, 32).split("");
  digits[12] = "5";
  const variant = Number.parseInt(digits[16], 16);
  digits[16] = ((variant & 0x3) | 0x8).toString(16);
  const value = digits.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

async function makeIdMap<T>(
  rows: T[],
  getId: (row: T) => string,
  table: string,
  targetOrganizationId: string,
  contentSha256: string,
): Promise<Map<string, string>> {
  const unique = [...new Set(rows.map(getId))];
  const mapped = await Promise.all(
    unique.map(
      async (id) =>
        [
          id,
          uuidFromHex(
            await sha256Json({
              targetOrganizationId,
              contentSha256,
              table,
              id,
            }),
          ),
        ] as const,
    ),
  );
  return new Map(mapped);
}

function requireMapped(
  map: Map<string, string>,
  id: string,
  relation: string,
): string {
  const mapped = map.get(id);
  if (!mapped)
    throw new ClientRestoreError(400, `Snapshot is missing ${relation}`);
  return mapped;
}

export async function remapPayload(
  payload: ClientRestorePayload,
  targetOrganizationId: string,
  contentSha256: string,
): Promise<ClientRestorePayload> {
  const projectMap = await makeIdMap(
    payload.projects,
    (row) => row.id,
    "projects",
    targetOrganizationId,
    contentSha256,
  );
  const competitorMap = await makeIdMap(
    payload.projectCompetitors,
    (row) => row.id,
    "project_competitors",
    targetOrganizationId,
    contentSha256,
  );
  const keyPageMap = await makeIdMap(
    payload.projectKeyPages,
    (row) => row.id,
    "project_key_pages",
    targetOrganizationId,
    contentSha256,
  );
  const researchLogMap = await makeIdMap(
    payload.projectResearchLog,
    (row) => row.id,
    "project_research_log",
    targetOrganizationId,
    contentSha256,
  );
  const trackerMap = await makeIdMap(
    payload.aiTrackers,
    (row) => row.id,
    "ai_trackers",
    targetOrganizationId,
    contentSha256,
  );
  const promptMap = await makeIdMap(
    payload.aiPrompts,
    (row) => row.id,
    "ai_prompts",
    targetOrganizationId,
    contentSha256,
  );
  const runMap = await makeIdMap(
    payload.aiRuns,
    (row) => row.id,
    "ai_runs",
    targetOrganizationId,
    contentSha256,
  );
  const observationMap = await makeIdMap(
    payload.aiObservations,
    (row) => row.id,
    "ai_observations",
    targetOrganizationId,
    contentSha256,
  );
  const sourceMap = await makeIdMap(
    payload.aiSources,
    (row) => row.id,
    "ai_sources",
    targetOrganizationId,
    contentSha256,
  );
  const matchMap = await makeIdMap(
    payload.aiMatches,
    (row) => row.id,
    "ai_matches",
    targetOrganizationId,
    contentSha256,
  );
  const nativeResultMap = await makeIdMap(
    payload.aiNativeResults,
    (row) => row.id,
    "ai_native_results",
    targetOrganizationId,
    contentSha256,
  );
  const nativeSourceMap = await makeIdMap(
    payload.aiNativeSources,
    (row) => row.id,
    "ai_native_sources",
    targetOrganizationId,
    contentSha256,
  );
  const nativeSearchSourceMap = await makeIdMap(
    payload.aiNativeSearchSources,
    (row) => row.id,
    "ai_native_search_sources",
    targetOrganizationId,
    contentSha256,
  );
  const nativeEvidenceMap = await makeIdMap(
    payload.aiNativeSearchEvidence,
    (row) => row.id,
    "ai_native_search_evidence",
    targetOrganizationId,
    contentSha256,
  );
  const mapProject = (projectId: string) =>
    requireMapped(projectMap, projectId, "project");
  const mapTracker = (trackerId: string) =>
    requireMapped(trackerMap, trackerId, "tracker");
  const mapPrompt = (promptId: string) =>
    requireMapped(promptMap, promptId, "question version");
  const mapRun = (runId: string) => requireMapped(runMap, runId, "run");
  const mapObservation = (observationId: string) =>
    requireMapped(observationMap, observationId, "answer");
  const mapNativeResult = (resultId: string) =>
    requireMapped(nativeResultMap, resultId, "native result");
  const remapped: ClientRestorePayload = {
    sourceOrganizationId: targetOrganizationId,
    projects: payload.projects.map((row) => ({
      ...row,
      id: mapProject(row.id),
      organizationId: targetOrganizationId,
    })),
    projectContextSections: payload.projectContextSections.map((row) => ({
      ...row,
      projectId: mapProject(row.projectId),
    })),
    projectCompetitors: payload.projectCompetitors.map((row) => ({
      ...row,
      id: requireMapped(competitorMap, row.id, "competitor"),
      projectId: mapProject(row.projectId),
    })),
    projectKeyPages: payload.projectKeyPages.map((row) => ({
      ...row,
      id: requireMapped(keyPageMap, row.id, "key page"),
      projectId: mapProject(row.projectId),
    })),
    projectResearchLog: payload.projectResearchLog.map((row) => ({
      ...row,
      id: requireMapped(researchLogMap, row.id, "research log"),
      projectId: mapProject(row.projectId),
    })),
    aiTrackers: payload.aiTrackers.map((row) => ({
      ...row,
      id: mapTracker(row.id),
      projectId: mapProject(row.projectId),
    })),
    aiPrompts: payload.aiPrompts.map((row) => ({
      ...row,
      id: mapPrompt(row.id),
      trackerId: mapTracker(row.trackerId),
    })),
    aiRuns: payload.aiRuns.map((row) => ({
      ...row,
      id: mapRun(row.id),
      trackerId: mapTracker(row.trackerId),
      projectId: mapProject(row.projectId),
    })),
    aiObservations: payload.aiObservations.map((row) => ({
      ...row,
      id: mapObservation(row.id),
      runId: mapRun(row.runId),
      promptId: mapPrompt(row.promptId),
    })),
    aiSources: payload.aiSources.map((row) => ({
      ...row,
      id: requireMapped(sourceMap, row.id, "answer source"),
      observationId: mapObservation(row.observationId),
    })),
    aiMatches: payload.aiMatches.map((row) => ({
      ...row,
      id: requireMapped(matchMap, row.id, "answer match"),
      observationId: mapObservation(row.observationId),
    })),
    aiNativeResults: payload.aiNativeResults.map((row) => ({
      ...row,
      id: requireMapped(nativeResultMap, row.id, "native result"),
      clientId: targetOrganizationId,
      projectId: mapProject(row.projectId),
      runId: mapRun(row.runId),
      questionId: mapPrompt(row.questionId),
      finalizationToken: null,
    })),
    aiNativeSources: payload.aiNativeSources.map((row) => ({
      ...row,
      id: requireMapped(nativeSourceMap, row.id, "native source"),
      resultId: mapNativeResult(row.resultId),
    })),
    aiNativeSearchSources: payload.aiNativeSearchSources.map((row) => ({
      ...row,
      id: requireMapped(nativeSearchSourceMap, row.id, "native search source"),
      resultId: mapNativeResult(row.resultId),
    })),
    aiNativeSearchEvidence: payload.aiNativeSearchEvidence.map((row) => ({
      ...row,
      id: requireMapped(nativeEvidenceMap, row.id, "search evidence"),
      resultId: mapNativeResult(row.resultId),
    })),
  };
  return {
    ...remapped,
    projects: ordered(remapped.projects, (row) => row.id),
    projectContextSections: ordered(
      remapped.projectContextSections,
      relationKey,
    ),
    projectCompetitors: ordered(remapped.projectCompetitors, relationKey),
    projectKeyPages: ordered(remapped.projectKeyPages, relationKey),
    projectResearchLog: ordered(remapped.projectResearchLog, relationKey),
    aiTrackers: ordered(remapped.aiTrackers, (row) => row.id),
    aiPrompts: ordered(remapped.aiPrompts, (row) => row.id),
    aiRuns: ordered(remapped.aiRuns, (row) => row.id),
    aiObservations: ordered(remapped.aiObservations, (row) => row.id),
    aiSources: ordered(remapped.aiSources, (row) => row.id),
    aiMatches: ordered(remapped.aiMatches, (row) => row.id),
    aiNativeResults: ordered(remapped.aiNativeResults, (row) => row.id),
    aiNativeSources: ordered(remapped.aiNativeSources, (row) => row.id),
    aiNativeSearchSources: ordered(
      remapped.aiNativeSearchSources,
      (row) => row.id,
    ),
    aiNativeSearchEvidence: ordered(
      remapped.aiNativeSearchEvidence,
      (row) => row.id,
    ),
  };
}

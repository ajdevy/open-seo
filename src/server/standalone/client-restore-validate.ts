import type { ClientRestorePayload } from "./client-restore-schema";
import {
  ClientRestoreError,
  assertProjectScopedRows,
  assertUniqueIds,
} from "./client-restore-schema";

export function validatePayload(payload: ClientRestorePayload) {
  const projectIds = assertUniqueIds(
    payload.projects,
    (row) => row.id,
    "project",
  );
  if (
    payload.projects.some(
      (row) => row.organizationId !== payload.sourceOrganizationId,
    )
  )
    throw new ClientRestoreError(
      400,
      "Snapshot contains a project from another client",
    );

  const contextKeys = new Set<string>();
  for (const row of payload.projectContextSections) {
    if (!projectIds.has(row.projectId))
      throw new ClientRestoreError(
        400,
        "Snapshot contains a cross-client project relation",
      );
    const key = `${row.projectId}\0${row.key}`;
    if (contextKeys.has(key))
      throw new ClientRestoreError(400, "Duplicate project context section");
    contextKeys.add(key);
  }

  assertProjectScopedRows(payload.projectCompetitors, "competitor", projectIds);
  assertProjectScopedRows(payload.projectKeyPages, "key page", projectIds);
  assertProjectScopedRows(
    payload.projectResearchLog,
    "research log",
    projectIds,
  );
  assertProjectScopedRows(payload.aiTrackers, "tracker", projectIds);
  assertProjectScopedRows(payload.aiRuns, "run", projectIds);
  assertProjectScopedRows(payload.aiNativeResults, "native result", projectIds);

  const trackerIds = assertUniqueIds(
    payload.aiTrackers,
    (row) => row.id,
    "tracker",
  );
  const promptIds = assertUniqueIds(
    payload.aiPrompts,
    (row) => row.id,
    "prompt",
  );
  const runIds = assertUniqueIds(payload.aiRuns, (row) => row.id, "run");
  const observationIds = assertUniqueIds(
    payload.aiObservations,
    (row) => row.id,
    "observation",
  );
  const nativeResultIds = assertUniqueIds(
    payload.aiNativeResults,
    (row) => row.id,
    "native result",
  );
  assertUniqueIds(payload.aiSources, (row) => row.id, "answer source");
  assertUniqueIds(payload.aiMatches, (row) => row.id, "answer match");
  assertUniqueIds(payload.aiNativeSources, (row) => row.id, "native source");
  assertUniqueIds(
    payload.aiNativeSearchSources,
    (row) => row.id,
    "native search source",
  );
  assertUniqueIds(
    payload.aiNativeSearchEvidence,
    (row) => row.id,
    "native search evidence",
  );

  const promptTracker = new Map<string, string>();
  for (const prompt of payload.aiPrompts) {
    if (!trackerIds.has(prompt.trackerId))
      throw new ClientRestoreError(
        400,
        "Snapshot contains a prompt without its tracker",
      );
    promptTracker.set(prompt.id, prompt.trackerId);
  }
  const trackerProject = new Map(
    payload.aiTrackers.map((row) => [row.id, row.projectId]),
  );
  const runProject = new Map<string, string>();
  const runTracker = new Map<string, string>();
  for (const run of payload.aiRuns) {
    if (
      !trackerIds.has(run.trackerId) ||
      trackerProject.get(run.trackerId) !== run.projectId
    )
      throw new ClientRestoreError(
        400,
        "Snapshot contains a run outside its project",
      );
    runProject.set(run.id, run.projectId);
    runTracker.set(run.id, run.trackerId);
  }
  for (const row of payload.aiObservations) {
    if (!runIds.has(row.runId) || !promptIds.has(row.promptId))
      throw new ClientRestoreError(
        400,
        "Snapshot contains an observation without its run or question",
      );
    const trackerId = runTracker.get(row.runId);
    if (trackerId !== promptTracker.get(row.promptId))
      throw new ClientRestoreError(
        400,
        "Snapshot contains an observation from another project",
      );
  }
  for (const row of payload.aiSources)
    if (!observationIds.has(row.observationId))
      throw new ClientRestoreError(
        400,
        "Snapshot contains a source without its answer",
      );
  for (const row of payload.aiMatches)
    if (!observationIds.has(row.observationId))
      throw new ClientRestoreError(
        400,
        "Snapshot contains a match without its answer",
      );
  for (const row of payload.aiNativeResults) {
    if (
      row.clientId !== payload.sourceOrganizationId ||
      runProject.get(row.runId) !== row.projectId ||
      promptTracker.get(row.questionId) !== runTracker.get(row.runId)
    )
      throw new ClientRestoreError(
        400,
        "Snapshot contains a native result outside its client or question history",
      );
  }
  for (const rows of [
    payload.aiNativeSources,
    payload.aiNativeSearchSources,
    payload.aiNativeSearchEvidence,
  ])
    if (rows.some((row) => !nativeResultIds.has(row.resultId)))
      throw new ClientRestoreError(
        400,
        "Snapshot contains native evidence without its result",
      );
}

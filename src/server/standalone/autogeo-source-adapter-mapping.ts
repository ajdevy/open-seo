import type { ClientRestorePayload } from "./client-restore-schema";
import { type PromptRef, type SourceRows } from "./autogeo-source-contract";
import type { AutoGeoMapping } from "./autogeo-source-adapter-schema";

type PromptRow = ClientRestorePayload["aiPrompts"][number];
type RunRow = ClientRestorePayload["aiRuns"][number];
type NativeResultRow = ClientRestorePayload["aiNativeResults"][number];
type NativeSourceRow = ClientRestorePayload["aiNativeSources"][number];

type PromptMappings = {
  rows: PromptRow[];
  targetIdBySourceKey: Map<string, string>;
  trackerIdBySourceKey: Map<string, string>;
  trackerIds: Set<string>;
  blockers: Set<string>;
};

type AnswerMappings = {
  runs: Map<string, RunRow>;
  results: NativeResultRow[];
  sources: NativeSourceRow[];
  projectIds: Set<string>;
  trackerIds: Set<string>;
  mappedCount: number;
  discoveredCount: number;
  blockers: Set<string>;
};

function sourcePromptKey(prompt: PromptRef): string {
  return `v${prompt.version}:${prompt.row.id}`;
}

function buildTargetMaps(mapping: AutoGeoMapping, blockers: Set<string>) {
  const projects = new Map(mapping.projects.map((row) => [row.id, row]));
  const trackers = new Map(mapping.trackers.map((row) => [row.id, row]));
  if (
    projects.size !== mapping.projects.length ||
    trackers.size !== mapping.trackers.length ||
    [...trackers.values()].some((row) => !projects.has(row.projectId))
  )
    blockers.add("invalid_target_context");
  return { projects, trackers };
}

function mapPrompts(
  source: SourceRows,
  mapping: AutoGeoMapping,
  projects: Map<string, AutoGeoMapping["projects"][number]>,
  trackers: Map<string, AutoGeoMapping["trackers"][number]>,
): PromptMappings {
  const rows: PromptRow[] = [];
  const targetIdBySourceKey = new Map<string, string>();
  const trackerIdBySourceKey = new Map<string, string>();
  const trackerIds = new Set<string>();
  const blockers = new Set<string>();
  for (const prompt of source.prompts) {
    const key = sourcePromptKey(prompt);
    const proposed = mapping.promptMappings[key];
    const tracker = proposed ? trackers.get(proposed.trackerId) : undefined;
    if (!proposed || !tracker || !projects.has(tracker.projectId)) {
      blockers.add("reviewed_prompt_mapping_missing");
      continue;
    }
    rows.push({
      id: proposed.id,
      trackerId: proposed.trackerId,
      topic: proposed.topic,
      text: prompt.row.text,
      paused: true,
      archived: true,
      createdAt: proposed.createdAt,
    });
    targetIdBySourceKey.set(key, proposed.id);
    trackerIdBySourceKey.set(key, proposed.trackerId);
    trackerIds.add(proposed.trackerId);
  }
  return {
    rows,
    targetIdBySourceKey,
    trackerIdBySourceKey,
    trackerIds,
    blockers,
  };
}

function uniquePromptVersions(source: SourceRows): Map<string, PromptRef> {
  const counts = new Map<string, number>();
  for (const prompt of source.prompts)
    counts.set(prompt.row.id, (counts.get(prompt.row.id) ?? 0) + 1);
  const unique = new Map<string, PromptRef>();
  for (const prompt of source.prompts)
    if (counts.get(prompt.row.id) === 1) unique.set(prompt.row.id, prompt);
  return unique;
}

function mapConfirmedCitations(
  value: unknown,
  confirmedIndexes: number[],
  resultId: string,
  blockers: Set<string>,
): NativeSourceRow[] {
  if (!isUnknownArray(value)) {
    if (confirmedIndexes.length > 0)
      blockers.add("unconfirmed_citation_not_mapped");
    return [];
  }
  const rows: NativeSourceRow[] = [];
  const seenIndexes = new Set<number>();
  for (const index of confirmedIndexes) {
    const citation = value[index];
    if (seenIndexes.has(index) || !isHttpsCitation(citation)) {
      blockers.add("unconfirmed_citation_not_mapped");
      continue;
    }
    seenIndexes.add(index);
    rows.push({
      id: `${resultId}:citation:${index}`,
      resultId,
      value: citation,
      position: index,
    });
  }
  return rows;
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isHttpsCitation(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" && url.username === "" && url.password === ""
    );
  } catch {
    return false;
  }
}

type AnswerContext = {
  sourceOrganizationId: string;
  source: SourceRows;
  mapping: AutoGeoMapping;
  promptMappings: PromptMappings;
  uniquePrompts: Map<string, PromptRef>;
  projects: Map<string, AutoGeoMapping["projects"][number]>;
  trackers: Map<string, AutoGeoMapping["trackers"][number]>;
};

function mapAnswer(
  runId: string,
  answer: SourceRows["runs"][number]["rows"][number],
  context: AnswerContext,
): { run: RunRow; result: NativeResultRow; sources: NativeSourceRow[] } | null {
  const { mapping, promptMappings, uniquePrompts, projects, trackers } =
    context;
  const prompt = uniquePrompts.get(answer.prompt_id);
  if (!prompt) return null;
  if (answer.locale !== prompt.row.locale) return null;
  const sourceKey = sourcePromptKey(prompt);
  const targetPromptId = promptMappings.targetIdBySourceKey.get(sourceKey);
  const answerMapping = mapping.answerMappings[`${runId}:${answer.answer_id}`];
  const runMapping = mapping.runMappings[runId];
  const tracker = runMapping ? trackers.get(runMapping.trackerId) : undefined;
  const project = runMapping ? projects.get(runMapping.projectId) : undefined;
  if (!targetPromptId || !answerMapping || !runMapping || !tracker || !project)
    return null;
  if (
    answerMapping.resultStatus === "pending" ||
    promptMappings.trackerIdBySourceKey.get(sourceKey) !==
      runMapping.trackerId ||
    tracker.projectId !== runMapping.projectId ||
    answerMapping.sourceStatus !== answer.status ||
    answerMapping.sourceProvider !== answer.provider ||
    (answer.status === "ok" && answerMapping.resultStatus !== "completed") ||
    (answer.status === "error" && answerMapping.resultStatus !== "failed") ||
    (answerMapping.resultStatus === "completed" &&
      (answer.text === undefined || answer.text.length === 0))
  )
    return null;

  const resultId = `autogeo:${mapping.clientRef}:${runId}:${answer.answer_id}`;
  const result: NativeResultRow = {
    id: resultId,
    schemaVersion: 1,
    clientId: context.sourceOrganizationId,
    projectId: runMapping.projectId,
    runId,
    questionId: targetPromptId,
    questionVersion: prompt.version,
    questionSnapshot: prompt.row.text,
    requestedModel: answer.model_id,
    observedModel: answer.observed_version?.trim()
      ? answer.observed_version
      : null,
    route: "unknown",
    resultStatus: answerMapping.resultStatus,
    answer:
      answerMapping.resultStatus === "completed" ? answer.text ?? null : null,
    searchStatus: answer.search_executed ?? "unknown",
    eligibleForVisibility: null,
    errorCode:
      answerMapping.resultStatus === "failed"
        ? "historical_source_failure"
        : null,
    turnStatus: null,
    collectedAt: answerMapping.collectedAt,
    finalizationToken: null,
  };
  const sources = mapConfirmedCitations(
    answer.citations,
    answerMapping.confirmedCitationIndexes,
    resultId,
    promptMappings.blockers,
  );
  return { run: { id: runId, ...runMapping }, result, sources };
}

function mapAnswers(context: AnswerContext): AnswerMappings {
  const runs = new Map<string, RunRow>();
  const results: NativeResultRow[] = [];
  const sources: NativeSourceRow[] = [];
  const projectIds = new Set<string>();
  const trackerIds = new Set<string>();
  const blockers = new Set<string>();
  let discoveredCount = 0;
  let mappedCount = 0;
  for (const run of context.source.runs) {
    for (const answer of run.rows) {
      discoveredCount++;
      const answerMapping =
        context.mapping.answerMappings[`${run.runId}:${answer.answer_id}`];
      const runMapping = context.mapping.runMappings[run.runId];
      if (
        runMapping?.status === "queued" ||
        runMapping?.status === "running" ||
        answerMapping?.resultStatus === "pending"
      ) {
        blockers.add("active_or_unconfirmed_run");
        continue;
      }
      const mapped = mapAnswer(run.runId, answer, context);
      if (!mapped) {
        blockers.add(
          context.uniquePrompts.has(answer.prompt_id)
            ? "reviewed_answer_mapping_missing_or_incompatible"
            : "ambiguous_or_missing_prompt_version",
        );
        continue;
      }
      runs.set(run.runId, mapped.run);
      results.push(mapped.result);
      sources.push(...mapped.sources);
      projectIds.add(mapped.run.projectId);
      trackerIds.add(mapped.run.trackerId);
      mappedCount++;
    }
  }
  return {
    runs,
    results,
    sources,
    projectIds,
    trackerIds,
    mappedCount,
    discoveredCount,
    blockers,
  };
}

export function prepareAutoGeoMappings(
  source: SourceRows,
  mapping: AutoGeoMapping,
  sourceOrganizationId: string,
) {
  const blockers = new Set<string>();
  const { projects, trackers } = buildTargetMaps(mapping, blockers);
  const prompts = mapPrompts(source, mapping, projects, trackers);
  const uniquePrompts = uniquePromptVersions(source);
  const answers = mapAnswers({
    sourceOrganizationId,
    source,
    mapping,
    promptMappings: prompts,
    uniquePrompts,
    projects,
    trackers,
  });
  const projectIds = new Set(answers.projectIds);
  const trackerIds = new Set([...prompts.trackerIds, ...answers.trackerIds]);
  for (const prompt of prompts.rows) {
    const tracker = trackers.get(prompt.trackerId);
    if (tracker) projectIds.add(tracker.projectId);
  }
  for (const id of projectIds)
    if (!projects.has(id)) blockers.add("invalid_target_context");
  for (const id of trackerIds)
    if (!trackers.has(id)) blockers.add("invalid_target_context");
  for (const blocker of prompts.blockers) blockers.add(blocker);
  for (const blocker of answers.blockers) blockers.add(blocker);
  return {
    projects,
    trackers,
    projectIds,
    trackerIds,
    prompts,
    answers,
    blockers,
  };
}

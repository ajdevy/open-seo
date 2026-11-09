import { sort } from "remeda";
import { AiVisibilityRepository as repo } from "../repositories/AiVisibilityRepository";
import { aiBrands } from "./aiVisibilityConfiguration";
import { AiVisibilityError } from "./aiVisibilityErrors";
import { loadAiFullAnswers } from "./aiVisibilityResults";
import { findingsFor } from "./aiVisibilityReportMatching";
import { ProjectContextRepository } from "@/server/features/project-context/repositories/ProjectContextRepository";
import {
  aiEngineUsesModelApi,
  AI_ENGINE_LABELS,
  type AiBrand,
  type AiNativeResult,
  type AiReportCoverage,
  type AiReportError,
  type AiReportModel,
  type AiReportRate,
  type AiReportSearchCoverage,
  type AiVisibilityReportAggregation,
  type AiEngine,
  type AiAnswer,
  isAiNativeSearchEvidenceTool,
} from "@/shared/ai-visibility";
import type { AiVisibilityReportAggregationInput } from "@/types/schemas/ai-visibility";
import { aiResultsSchema } from "@/types/schemas/ai-visibility";
import { CUSTOM_SECTION_KEY_PREFIX } from "@/types/schemas/projectContext";
import {
  BRAND_IDENTITY_VARIANTS_SLUG,
  parseBrandIdentityVariants,
} from "@/shared/project-context/brandIdentityVariants";

type ReportResultSet = Awaited<ReturnType<typeof loadAiFullAnswers>>["result"];
type LegacyEntry = {
  kind: "legacy";
  key: string;
  model: string;
  route: string;
  engine: AiEngine;
  status: string;
  searchStatus: string;
  evaluable: boolean;
  answer: AiAnswer;
};
type NativeEntry = {
  kind: "native";
  key: string;
  model: string;
  route: string;
  status: string;
  searchStatus: string;
  evaluable: boolean;
  result: AiNativeResult;
};
type ReportEntry = LegacyEntry | NativeEntry;

function rate(numerator: number, denominator: number): AiReportRate {
  return {
    numerator,
    denominator,
    percentage:
      denominator > 0
        ? Math.round((numerator / denominator) * 1000) / 10
        : null,
  };
}

function reportCoverage(
  entries: ReportEntry[],
  planned: number,
): AiReportCoverage {
  const failed = entries.filter((entry) => entry.status === "failed").length;
  const pending =
    entries.filter(
      (entry) => entry.status !== "completed" && entry.status !== "failed",
    ).length + Math.max(0, planned - entries.length);
  const evaluable = entries.filter((entry) => entry.evaluable).length;
  const received = Math.max(0, planned - pending);
  if (failed + evaluable > received) {
    throw new AiVisibilityError(
      "INVALID_REPORT_DATA",
      "The result statuses overlap and cannot be reported safely.",
    );
  }
  const unevaluable = Math.max(0, received - failed - evaluable);

  return {
    planned,
    received,
    evaluable,
    failed,
    pending,
    unevaluable,
    unassignedPending: Math.max(0, planned - entries.length),
    receivedCoverage: rate(received, planned),
    evaluableCoverage: rate(evaluable, planned),
    evaluationRate: rate(evaluable, received),
  };
}

function legacyRoute(engine: AiEngine): string {
  return aiEngineUsesModelApi(engine)
    ? "dataforseo-model-api"
    : "dataforseo-ai-search";
}

function legacyEntry(answer: AiAnswer): LegacyEntry {
  const { observation } = answer;
  const route = legacyRoute(observation.engine);
  const hasAnswer = !!answer.answerText?.trim();
  const modelApi = aiEngineUsesModelApi(observation.engine);
  const searchStatus =
    observation.status === "failed"
      ? "failed"
      : observation.status !== "completed"
        ? "pending"
        : modelApi
          ? "not_reported"
          : "provider_completed";
  return {
    kind: "legacy",
    key: `legacy\u0000${observation.runId}\u0000${observation.promptId}\u0000${observation.engine}`,
    model: observation.engine,
    route,
    engine: observation.engine,
    status: observation.status,
    searchStatus,
    // The legacy Claude/Perplexity path requested web search but did not save
    // its observed search state. Do not turn that missing evidence into a hit.
    evaluable: observation.status === "completed" && hasAnswer && !modelApi,
    answer,
  };
}

function nativeEntry(result: AiNativeResult): NativeEntry {
  const hasCompletedSearchEvidence =
    result.searchStatus === "completed" &&
    result.searchEvidence.some(
      (event) =>
        isAiNativeSearchEvidenceTool(event.tool) &&
        event.status === "completed",
    );

  return {
    kind: "native",
    key: JSON.stringify([
      "native",
      result.runId,
      result.questionId,
      result.questionVersion,
      result.requestedModel,
      result.route,
    ]),
    model: result.requestedModel,
    route: result.route,
    status: result.resultStatus,
    searchStatus: result.searchStatus || "unknown",
    evaluable:
      result.resultStatus === "completed" &&
      result.eligibleForVisibility === true &&
      !!result.answer?.trim() &&
      hasCompletedSearchEvidence,
    result,
  };
}

function entryScore(entry: ReportEntry) {
  return entry.evaluable
    ? 3
    : entry.status === "completed" || entry.status === "failed"
      ? 2
      : 1;
}

function entryCollectedAt(entry: ReportEntry) {
  return entry.kind === "legacy"
    ? (entry.answer.observation.collectedAt ?? "")
    : entry.result.collectedAt;
}

function preferEntry(candidate: ReportEntry, current: ReportEntry): boolean {
  if (entryScore(candidate) !== entryScore(current))
    return entryScore(candidate) > entryScore(current);
  return entryCollectedAt(candidate) > entryCollectedAt(current);
}

function uniqueEntries(entries: ReportEntry[]): ReportEntry[] {
  const unique = new Map<string, ReportEntry>();
  for (const entry of entries) {
    const current = unique.get(entry.key);
    if (!current || preferEntry(entry, current)) unique.set(entry.key, entry);
  }
  return [...unique.values()];
}

function searchCoverage(entries: ReportEntry[]): AiReportSearchCoverage {
  let confirmed = 0;
  let unconfirmed = 0;
  let failed = 0;
  let pending = 0;
  let notReported = 0;
  const states = new Map<string, number>();

  for (const entry of entries) {
    states.set(entry.searchStatus, (states.get(entry.searchStatus) ?? 0) + 1);
    if (entry.status === "failed") failed++;
    else if (entry.status !== "completed") pending++;
    else if (entry.searchStatus === "not_reported") notReported++;
    else if (
      entry.evaluable ||
      (entry.kind === "legacy" && entry.searchStatus === "provider_completed")
    )
      confirmed++;
    else unconfirmed++;
  }

  return {
    confirmed,
    unconfirmed,
    failed,
    pending,
    notReported,
    states: sort(
      [...states].map(([status, count]) => ({ status, count })),
      (left, right) => left.status.localeCompare(right.status),
    ),
  };
}

function errorsFor(entries: ReportEntry[]): AiReportError[] {
  return entries.flatMap<AiReportError>((entry) => {
    if (entry.kind === "legacy") {
      const { observation } = entry.answer;
      if (observation.status !== "failed" && !observation.error) return [];
      return [
        {
          kind: "legacy" as const,
          model: entry.model,
          route: entry.route,
          questionId: observation.promptId,
          question: observation.prompt,
          status: observation.status,
          code: null,
          message: observation.error,
        },
      ];
    }
    const result = entry.result;
    if (result.resultStatus !== "failed" && !result.errorCode) return [];
    return [
      {
        kind: "native" as const,
        model: entry.model,
        route: entry.route,
        questionId: result.questionId,
        question: result.question,
        status: result.resultStatus,
        code: result.errorCode,
        message: null,
      },
    ];
  });
}

function modelsFor(entries: ReportEntry[], brands: AiBrand[]): AiReportModel[] {
  const groups = new Map<string, ReportEntry[]>();
  for (const entry of entries) {
    const key =
      entry.kind === "legacy"
        ? `legacy:${entry.engine}`
        : `native:${entry.model.toLocaleLowerCase()}@${entry.route.toLocaleLowerCase()}`;
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }

  return sort(
    [...groups].map(([key, group]) => {
      const first = group[0];
      const legacy = first.kind === "legacy";
      return {
        key,
        kind: first.kind,
        model: legacy ? AI_ENGINE_LABELS[first.engine] : first.model,
        route: first.route,
        engine: legacy ? first.engine : null,
        coverage: reportCoverage(group, group.length),
        search: searchCoverage(group),
        findings: findingsFor(group, brands),
      };
    }),
    (left, right) =>
      left.model.localeCompare(right.model) ||
      left.route.localeCompare(right.route),
  );
}

function aggregate(
  results: ReportResultSet,
  answers: AiAnswer[],
  configuredBrands: AiBrand[],
): AiVisibilityReportAggregation {
  if (results.appliedFilters.competitorGap || results.truncated) {
    throw new AiVisibilityError(
      "INCOMPLETE_REPORT_DATA",
      "Use one complete, non-gap run to build report coverage.",
    );
  }

  const legacy = answers.map(legacyEntry);
  const native = results.nativeResults.map(nativeEntry);
  const rawEntries = [...legacy, ...native];
  const entries = uniqueEntries(rawEntries);
  // The source result set counts persisted rows. Repeated attempts for the
  // same question/model are one planned item for every report metric.
  const planned = Math.max(
    entries.length,
    results.coverage.expected - (rawEntries.length - entries.length),
  );
  if (planned < entries.length) {
    throw new AiVisibilityError(
      "INVALID_REPORT_DATA",
      "The saved results exceed the number of planned report tasks.",
    );
  }
  const coverage = reportCoverage(entries, planned);
  // Missing records have no reliable model/route identity. Keep them visible
  // in the overall pending count instead of assigning them to a guessed model.
  const findings = findingsFor(entries, configuredBrands);
  // Keep failure diagnostics visible even when a duplicate retry is excluded
  // from the one-answer-per-task coverage calculation.
  const errors = errorsFor(rawEntries);

  return {
    run: results.run,
    coverage,
    search: searchCoverage(entries),
    findings,
    models: modelsFor(entries, configuredBrands),
    errors,
    answers: {
      legacy: entries.flatMap((entry) =>
        entry.kind === "legacy" ? [entry.answer] : [],
      ),
      native: entries.flatMap((entry) =>
        entry.kind === "native" ? [entry.result] : [],
      ),
    },
  };
}

/**
 * Builds a run-wide report from the stored question revision and result
 * evidence. It never calls a model provider or retries a collection.
 */
export async function loadAiVisibilityReportAggregation(
  input: AiVisibilityReportAggregationInput,
): Promise<AiVisibilityReportAggregation> {
  const resultInput = aiResultsSchema.parse({
    projectId: input.projectId,
    runId: input.runId,
    topic: null,
    engines: null,
    promptId: null,
    includeHistory: false,
    competitorGap: false,
    branded: "all",
  });
  const [full, project, competitors, contextSections] = await Promise.all([
    loadAiFullAnswers(resultInput),
    repo.getProject(input.projectId),
    repo.listCompetitors(input.projectId),
    ProjectContextRepository.listSections(input.projectId),
  ]);
  // Current project identities are the fallback for native results, which do
  // not yet persist a separate brand-identity snapshot.
  const identityContent = contextSections.find(
    (section) =>
      section.key ===
      `${CUSTOM_SECTION_KEY_PREFIX}${BRAND_IDENTITY_VARIANTS_SLUG}`,
  )?.content;
  const identityVariants = parseBrandIdentityVariants(identityContent ?? "");
  const configuredBrands = project ? aiBrands(project, competitors) : [];
  const reportBrands = configuredBrands.map((brand) =>
    brand.own ? { ...brand, identityVariants } : brand,
  );
  return aggregate(full.result, full.answers, reportBrands);
}

import type {
  AiAnswer,
  AiNativeResult,
  AiResults,
  AiRun,
} from "@/shared/ai-visibility";

export const runId = "00000000-0000-4000-8000-000000000002";
export const projectId = "00000000-0000-4000-8000-000000000001";
export const request = { projectId, runId };
export const ownProject = { name: "Acme", domain: "acme.example" };

function run(): AiRun {
  return {
    id: runId,
    status: "completed",
    trigger: "scheduled",
    expected: 0,
    completed: 0,
    failed: 0,
    pending: 0,
    createdAt: "2026-10-01T12:00:00.000Z",
    completedAt: "2026-10-01T12:05:00.000Z",
    pollAfterSeconds: 20,
  };
}

export function nativeResult(input: {
  id: string;
  status?: string;
  eligible?: boolean | null;
  answer?: string | null;
  model?: string;
  questionId?: string;
  searchStatus?: string;
  sources?: string[];
  errorCode?: string | null;
}): AiNativeResult {
  return {
    id: input.id,
    schemaVersion: 1,
    clientId: "client-1",
    projectId,
    runId,
    questionId: input.questionId ?? `question-${input.id}`,
    questionVersion: 1,
    question: `Question ${input.id}`,
    requestedModel: input.model ?? "synthetic/model",
    observedModel: null,
    route: "synthetic-route",
    resultStatus: input.status ?? "completed",
    answer: input.answer ?? null,
    searchStatus: input.searchStatus ?? "unknown",
    searchEvidence: [],
    searchSources: [],
    sources: input.sources ?? [],
    eligibleForVisibility: input.eligible ?? null,
    errorCode: input.errorCode ?? null,
    turnStatus: null,
    collectedAt: "2026-10-01T12:00:00.000Z",
  };
}

export function answer(input: {
  id: string;
  status?: "pending" | "completed" | "failed";
  engine?: AiAnswer["observation"]["engine"];
  text?: string | null;
  error?: string | null;
  sources?: {
    url: string;
    domain: string;
    title: string | null;
    position: number;
  }[];
}): AiAnswer {
  return {
    observation: {
      id: input.id,
      runId: runId,
      promptId: `prompt-${input.id}`,
      prompt: `Question ${input.id}`,
      topic: "General",
      branded: false,
      engine: input.engine ?? "chatgpt",
      status: input.status ?? "completed",
      answerStatus:
        input.status === "failed" || input.status === "pending"
          ? null
          : input.text
            ? "answered"
            : "no_answer",
      brands: [],
      citationCount: input.sources?.length ?? 0,
      collectedAt: "2026-10-01T12:00:00.000Z",
      error: input.error ?? null,
    },
    answerText: input.text ?? null,
    answerMarkdown: input.text ?? null,
    sources: input.sources ?? [],
    mentions: [],
    requestedLocationCode: 2840,
    requestedLanguageCode: "en",
    truncated: false,
  };
}

export function result(overrides: Partial<AiResults> = {}): AiResults {
  return {
    runId: runId,
    run: run(),
    rows: [],
    nativeResults: [],
    totalCount: 0,
    nextCursor: null,
    summaries: [],
    coverage: {
      expected: 0,
      completed: 0,
      noAnswer: 0,
      failed: 0,
      pending: 0,
    },
    appliedFilters: {
      topic: undefined,
      engines: undefined,
      competitorGap: false,
      branded: "all",
    },
    truncated: false,
    ...overrides,
  };
}

import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAiVisibilityNativeRun,
  getAiVisibilityReportAggregation,
  getAiVisibilityRun,
  getAiVisibilityResults,
  runAiVisibilityCheck,
} from "@/serverFunctions/ai-visibility";
import type {
  AiNativeResult,
  AiRun,
  AiVisibilityReportAggregation,
} from "@/shared/ai-visibility";
import {
  aiRunPollingInterval,
  aiRunReportQueryOptions,
  aiRunQueryOptions,
  aiRunResultsQueryOptions,
} from "./shared";

const { readResults, readReport, readRun } = vi.hoisted(() => ({
  readResults: vi.fn(),
  readReport: vi.fn(),
  readRun: vi.fn(),
}));
vi.mock("@/serverFunctions/ai-visibility", () => ({
  getAiResearchSetup: vi.fn(),
  getAiVisibilityReportAggregation: readReport,
  getAiVisibilityRun: readRun,
  getAiVisibilityTracker: vi.fn(),
  getAiVisibilityTrend: vi.fn(),
  getAiVisibilityResults: readResults,
  createAiVisibilityNativeRun: vi.fn(),
  recordAiVisibilityNativeRunResult: vi.fn(),
  runAiVisibilityCheck: vi.fn(),
  listAiResearchKeywords: vi.fn(),
}));

const projectId = "00000000-0000-4000-8000-000000000101";
const runId = "00000000-0000-4000-8000-000000000201";
const nativeResult: AiNativeResult = {
  id: "00000000-0000-4000-8000-000000000301",
  schemaVersion: 1,
  clientId: "organization",
  projectId,
  runId,
  questionId: "00000000-0000-4000-8000-000000000401",
  questionVersion: 1,
  question: "Which SEO tools are useful?",
  requestedModel: "model-a",
  observedModel: "model-a",
  route: "codex_cli",
  resultStatus: "completed",
  answer: "A saved synthetic answer.",
  searchStatus: "completed",
  searchEvidence: [],
  searchSources: [],
  sources: [],
  eligibleForVisibility: true,
  errorCode: null,
  turnStatus: null,
  collectedAt: "2026-11-06T12:00:00.000Z",
};
const page = {
  runId,
  run: null,
  rows: [],
  nativeResults: [nativeResult],
  totalCount: 0,
  nextCursor: null,
  summaries: [],
  coverage: { expected: 1, completed: 1, noAnswer: 0, failed: 0, pending: 0 },
  appliedFilters: {
    topic: undefined,
    engines: undefined,
    competitorGap: false,
    branded: "all" as const,
  },
  truncated: false,
  historyRuns: [],
};
const runningRun = {
  id: runId,
  status: "running" as const,
  trigger: "manual" as const,
  expected: 2,
  completed: 1,
  failed: 0,
  pending: 1,
  createdAt: "2026-11-06T12:00:00.000Z",
  completedAt: null,
  pollAfterSeconds: 7,
};

function report(run: AiRun): AiVisibilityReportAggregation {
  const emptyRate = { numerator: 0, denominator: 0, percentage: null };
  return {
    run,
    coverage: {
      planned: 0,
      received: 0,
      evaluable: 0,
      failed: 0,
      pending: 0,
      unevaluable: 0,
      unassignedPending: 0,
      receivedCoverage: emptyRate,
      evaluableCoverage: emptyRate,
      evaluationRate: emptyRate,
    },
    search: {
      confirmed: 0,
      unconfirmed: 0,
      failed: 0,
      pending: 0,
      notReported: 0,
      states: [],
    },
    findings: [],
    models: [],
    errors: [],
    answers: { legacy: [], native: [] },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAiVisibilityResults).mockResolvedValue(page);
});

describe("AI visibility run results query", () => {
  it("preserves native results from the project-authorized results read", async () => {
    const queryClient = new QueryClient();
    const result = await queryClient.fetchQuery(
      aiRunResultsQueryOptions(projectId, runId),
    );

    expect(getAiVisibilityResults).toHaveBeenCalledWith({
      data: { projectId, runId, branded: "all" },
    });
    expect(result.rows).toEqual([]);
    expect(result.nativeResults).toEqual([nativeResult]);
  });

  it("re-reads the same run ID while pending and stops after a terminal status", async () => {
    const queryClient = new QueryClient();
    vi.mocked(getAiVisibilityResults).mockResolvedValue({
      ...page,
      run: runningRun,
    });
    const options = aiRunResultsQueryOptions(projectId, runId);

    await queryClient.fetchQuery({ ...options, staleTime: 0 });
    await queryClient.fetchQuery({ ...options, staleTime: 0 });

    expect(getAiVisibilityResults).toHaveBeenNthCalledWith(1, {
      data: { projectId, runId, branded: "all" },
    });
    expect(getAiVisibilityResults).toHaveBeenNthCalledWith(2, {
      data: { projectId, runId, branded: "all" },
    });
    expect(aiRunPollingInterval(runningRun)).toBe(7000);
    expect(aiRunPollingInterval({ ...runningRun, status: "partial" })).toBe(
      false,
    );
    expect(createAiVisibilityNativeRun).not.toHaveBeenCalled();
    expect(runAiVisibilityCheck).not.toHaveBeenCalled();
  });

  it("polls status by the selected run ID without creating another run", async () => {
    const queryClient = new QueryClient();
    vi.mocked(getAiVisibilityRun).mockResolvedValue(runningRun);
    const options = aiRunQueryOptions(projectId, runId);

    await queryClient.fetchQuery({ ...options, staleTime: 0 });
    await queryClient.fetchQuery({ ...options, staleTime: 0 });

    expect(getAiVisibilityRun).toHaveBeenNthCalledWith(1, {
      data: { projectId, runId },
    });
    expect(getAiVisibilityRun).toHaveBeenNthCalledWith(2, {
      data: { projectId, runId },
    });
    expect(createAiVisibilityNativeRun).not.toHaveBeenCalled();
    expect(runAiVisibilityCheck).not.toHaveBeenCalled();
  });

  it("polls an open report while queued or running and stops at terminal status", () => {
    const queryClient = new QueryClient();
    const options = aiRunReportQueryOptions(projectId, runId);
    const interval = options.refetchInterval;
    expect(typeof interval).toBe("function");
    if (typeof interval !== "function")
      throw new Error("Expected report polling.");
    const query = queryClient.getQueryCache().build(queryClient, options);

    query.setData(report(runningRun));
    expect(interval(query)).toBe(7000);
    query.setData(report({ ...runningRun, status: "queued" }));
    expect(interval(query)).toBe(7000);

    for (const status of ["completed", "partial", "failed"] as const) {
      query.setData(report({ ...runningRun, status }));
      expect(interval(query)).toBe(false);
    }
    expect(getAiVisibilityReportAggregation).not.toHaveBeenCalled();
  });
});

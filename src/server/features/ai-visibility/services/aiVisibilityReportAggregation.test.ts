import { describe, expect, it, vi } from "vitest";
import type { AiResults, AiTrend } from "@/shared/ai-visibility";
import type { loadAiPageResults } from "./aiVisibilityResults";
import { loadAiVisibilityReportAggregation } from "./aiVisibilityReportAggregation";

const mocks = vi.hoisted(() => ({
  loadAiPageResults: vi.fn(),
  loadAiTrend: vi.fn(),
}));
vi.mock("./aiVisibilityResults", () => ({
  loadAiPageResults: mocks.loadAiPageResults,
}));
vi.mock("./aiVisibilityTrend", () => ({ loadAiTrend: mocks.loadAiTrend }));

type PageResults = Awaited<ReturnType<typeof loadAiPageResults>>;
const projectId = "00000000-0000-4000-8000-000000000001";
const request = {
  results: {
    projectId,
    runId: null,
    topic: null,
    engines: null,
    promptId: null,
    includeHistory: false,
    competitorGap: false,
    branded: "neutral" as const,
  },
  trend: { projectId, days: 7 as const },
};

function row(
  id: string,
  status: "pending" | "completed" | "failed",
  answerStatus: "answered" | "no_answer" | null,
): AiResults["rows"][number] {
  return {
    id,
    runId: "run-1",
    promptId: `prompt-${id}`,
    prompt: "synthetic prompt",
    topic: "General",
    branded: false,
    engine: "chatgpt",
    status,
    answerStatus,
    brands: [],
    citationCount: 0,
    collectedAt: null,
    error: null,
  };
}

function nativeResult(
  id: string,
  resultStatus: string,
  eligibleForVisibility: boolean | null,
  answer: string | null,
): AiResults["nativeResults"][number] {
  return {
    id,
    schemaVersion: 1,
    clientId: "client-1",
    projectId,
    runId: "run-1",
    questionId: `prompt-${id}`,
    questionVersion: 1,
    question: "synthetic prompt",
    requestedModel: "synthetic/model",
    observedModel: null,
    route: "synthetic-route",
    resultStatus,
    answer,
    searchStatus: "unknown",
    searchEvidence: [],
    searchSources: [],
    sources: [],
    eligibleForVisibility,
    errorCode: null,
    turnStatus: null,
    collectedAt: "2026-10-01T12:00:00.000Z",
  };
}

function pageResults(overrides: Partial<PageResults> = {}): PageResults {
  const defaults: PageResults = {
    runId: "run-1",
    run: null,
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
      branded: "neutral",
    },
    truncated: false,
    historyRuns: [],
  };
  return { ...defaults, ...overrides };
}

function trend(): AiTrend {
  const metric = {
    current: null,
    previous: null,
    change: null,
    matchedCells: 0,
    currentCells: 0,
    previousCells: 0,
  };
  const period = {
    start: "2026-09-17T12:00:00.000Z",
    end: "2026-10-01T12:00:00.000Z",
    coverage: { runs: 0, expected: 0, answered: 0, noAnswer: 0, failed: 0 },
  };
  return {
    days: 7,
    comparison: "no_data",
    current: period,
    previous: period,
    mentions: metric,
    citations: metric,
    engines: [],
    runs: [],
  };
}

describe("loadAiVisibilityReportAggregation", () => {
  it("aggregates planned and finalized outcomes while excluding unconfirmed negatives", async () => {
    const results = pageResults({
      rows: [
        row("answered", "completed", "answered"),
        row("no-answer", "completed", "no_answer"),
        row("failed", "failed", null),
        row("pending", "pending", null),
      ],
      nativeResults: [
        nativeResult("eligible", "completed", true, "confirmed result"),
        nativeResult("unconfirmed", "completed", false, "no search evidence"),
        nativeResult("native-failed", "failed", null, null),
        nativeResult("native-pending", "pending", null, null),
        nativeResult("partial", "partial", null, "incomplete result"),
      ],
      totalCount: 4,
      summaries: [
        {
          name: "Acme",
          domain: "acme.example",
          own: true,
          answers: 1,
          mentions: 0,
          citations: 0,
          positionTotal: 0,
          positionCount: 0,
        },
      ],
      coverage: {
        expected: 9,
        completed: 3,
        noAnswer: 1,
        failed: 2,
        pending: 3,
      },
    });
    const currentTrend = trend();
    mocks.loadAiPageResults.mockResolvedValue(results);
    mocks.loadAiTrend.mockResolvedValue(currentTrend);

    const actual = await loadAiVisibilityReportAggregation(request);

    expect(actual.coverage).toEqual({
      planned: 9,
      received: 6,
      evaluable: 2,
      failed: 2,
      pending: 3,
      unevaluable: 2,
      receivedCoverage: { numerator: 6, denominator: 9, percentage: 66.7 },
      evaluableCoverage: { numerator: 2, denominator: 9, percentage: 22.2 },
      evaluationRate: { numerator: 2, denominator: 6, percentage: 33.3 },
    });
    expect(actual.findings).toEqual([
      {
        name: "Acme",
        domain: "acme.example",
        own: true,
        evaluableAnswers: 1,
        mentions: {
          present: { numerator: 0, denominator: 1, percentage: 0 },
          absent: { numerator: 1, denominator: 1, percentage: 100 },
        },
        citations: {
          present: { numerator: 0, denominator: 1, percentage: 0 },
          absent: { numerator: 1, denominator: 1, percentage: 100 },
        },
      },
    ]);
    expect(actual.trend).toBe(currentTrend);
    expect(mocks.loadAiPageResults).toHaveBeenCalledWith({
      ...request.results,
      limit: undefined,
    });
    expect(mocks.loadAiTrend).toHaveBeenCalledWith(request.trend);
  });

  it("returns null percentages when no tasks provide a denominator", async () => {
    mocks.loadAiPageResults.mockResolvedValue(
      pageResults({
        summaries: [
          {
            name: "Acme",
            domain: "acme.example",
            own: true,
            answers: 0,
            mentions: 0,
            citations: 0,
            positionTotal: 0,
            positionCount: 0,
          },
        ],
      }),
    );
    mocks.loadAiTrend.mockResolvedValue(trend());

    const actual = await loadAiVisibilityReportAggregation(request);

    expect(actual.coverage.receivedCoverage).toEqual({
      numerator: 0,
      denominator: 0,
      percentage: null,
    });
    expect(actual.coverage.evaluableCoverage.percentage).toBeNull();
    expect(actual.coverage.evaluationRate.percentage).toBeNull();
    expect(actual.findings[0].mentions.absent.percentage).toBeNull();
    expect(actual.findings[0].citations.absent.percentage).toBeNull();
  });

  it("rejects cross-project inputs before reading report data", async () => {
    await expect(
      loadAiVisibilityReportAggregation({
        ...request,
        trend: {
          ...request.trend,
          projectId: "00000000-0000-4000-8000-000000000002",
        },
      }),
    ).rejects.toThrow("same project");
    expect(mocks.loadAiPageResults).not.toHaveBeenCalled();
    expect(mocks.loadAiTrend).not.toHaveBeenCalled();
  });

  it("rejects partial data instead of publishing partial negatives", async () => {
    mocks.loadAiPageResults.mockResolvedValue(
      pageResults({
        rows: [row("one-of-two", "completed", "answered")],
        totalCount: 2,
        coverage: {
          expected: 1,
          completed: 1,
          noAnswer: 0,
          failed: 0,
          pending: 0,
        },
      }),
    );
    mocks.loadAiTrend.mockResolvedValue(trend());

    await expect(loadAiVisibilityReportAggregation(request)).rejects.toThrow(
      "complete, non-gap result set",
    );
  });

  it("rejects gap-filtered data instead of publishing partial negatives", async () => {
    mocks.loadAiPageResults.mockResolvedValue(
      pageResults({
        totalCount: 1,
        appliedFilters: {
          topic: undefined,
          engines: undefined,
          competitorGap: true,
          branded: "neutral",
        },
      }),
    );
    mocks.loadAiTrend.mockResolvedValue(trend());

    await expect(loadAiVisibilityReportAggregation(request)).rejects.toThrow(
      "complete, non-gap result set",
    );
  });
});

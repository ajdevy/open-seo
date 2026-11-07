import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAiVisibilityResults } from "@/serverFunctions/ai-visibility";
import type { AiNativeResult } from "@/shared/ai-visibility";
import { aiRunResultsQueryOptions } from "./shared";

const { readResults } = vi.hoisted(() => ({ readResults: vi.fn() }));
vi.mock("@/serverFunctions/ai-visibility", () => ({
  getAiResearchSetup: vi.fn(),
  getAiVisibilityRun: vi.fn(),
  getAiVisibilityTracker: vi.fn(),
  getAiVisibilityTrend: vi.fn(),
  getAiVisibilityResults: readResults,
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
});

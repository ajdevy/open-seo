import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadAiVisibilityReportAggregation } from "./aiVisibilityReportAggregation";
import {
  nativeResult,
  ownProject,
  request,
  result,
} from "./aiVisibilityReportAggregation.fixtures";

const mocks = vi.hoisted(() => ({
  loadAiFullAnswers: vi.fn(),
  getProject: vi.fn(),
  listCompetitors: vi.fn(),
  listSections: vi.fn(),
}));

vi.mock("./aiVisibilityResults", () => ({
  loadAiFullAnswers: mocks.loadAiFullAnswers,
}));
vi.mock("../repositories/AiVisibilityRepository", () => ({
  AiVisibilityRepository: {
    getProject: mocks.getProject,
    listCompetitors: mocks.listCompetitors,
  },
}));
vi.mock(
  "@/server/features/project-context/repositories/ProjectContextRepository",
  () => ({
    ProjectContextRepository: { listSections: mocks.listSections },
  }),
);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getProject.mockResolvedValue(ownProject);
  mocks.listCompetitors.mockResolvedValue([]);
  mocks.listSections.mockResolvedValue([]);
});

describe("AI visibility report search evidence", () => {
  it("does not confirm native answers from invalid or missing search evidence", async () => {
    mocks.loadAiFullAnswers.mockResolvedValue({
      result: result({
        nativeResults: [
          nativeResult({
            id: "unknown-search",
            eligible: true,
            searchStatus: "unknown",
            searchEvidence: [
              {
                tool: "web_search",
                status: "completed",
                evidenceRef: "event-1",
              },
            ],
            answer: "Acme appears in this answer, but search is unknown.",
          }),
          nativeResult({
            id: "missing-search-evidence",
            eligible: true,
            searchStatus: "completed",
            searchEvidence: [],
            answer: "Acme appears in this answer, but evidence is missing.",
          }),
          nativeResult({
            id: "legacy-search-label-on-native-result",
            eligible: false,
            searchStatus: "provider_completed",
            answer:
              "Acme appears in this answer with a noncanonical search status.",
          }),
        ],
        coverage: {
          expected: 3,
          completed: 3,
          noAnswer: 0,
          failed: 0,
          pending: 0,
        },
      }),
      answers: [],
    });

    const actual = await loadAiVisibilityReportAggregation(request);

    expect(actual.coverage).toMatchObject({
      planned: 3,
      received: 3,
      evaluable: 0,
      unevaluable: 3,
    });
    expect(actual.search).toEqual({
      confirmed: 0,
      unconfirmed: 3,
      failed: 0,
      pending: 0,
      notReported: 0,
      states: [
        { status: "completed", count: 1 },
        { status: "provider_completed", count: 1 },
        { status: "unknown", count: 1 },
      ],
    });
    expect(actual.findings[0].mentions.present.percentage).toBeNull();
    expect(actual.findings[0].mentions.absent.percentage).toBeNull();
  });
});

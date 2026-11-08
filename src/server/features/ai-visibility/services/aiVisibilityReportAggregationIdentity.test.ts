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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadAiFullAnswers.mockResolvedValue({ result: result(), answers: [] });
  mocks.getProject.mockResolvedValue(ownProject);
  mocks.listCompetitors.mockResolvedValue([]);
});

describe("AI visibility report task identity", () => {
  it("keeps native tasks distinct by route and question version", async () => {
    const nativeResults = [
      nativeResult({
        id: "route-a-version-1",
        questionId: "same-question",
        questionVersion: 1,
        route: "provider-a",
        model: "vendor/model-a",
        eligible: true,
        searchStatus: "completed",
        answer: "Answer from route A for version 1.",
      }),
      nativeResult({
        id: "route-b-version-1",
        questionId: "same-question",
        questionVersion: 1,
        route: "provider-b",
        model: "vendor/model-a",
        eligible: true,
        searchStatus: "completed",
        answer: "Answer from route B for version 1.",
      }),
      nativeResult({
        id: "route-a-version-2",
        questionId: "same-question",
        questionVersion: 2,
        route: "provider-a",
        model: "vendor/model-a",
        eligible: true,
        searchStatus: "completed",
        answer: "Answer from route A for version 2.",
      }),
    ];
    mocks.loadAiFullAnswers.mockResolvedValue({
      result: result({
        nativeResults,
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

    expect(actual.coverage.planned).toBe(3);
    expect(actual.coverage.evaluable).toBe(3);
    expect(actual.answers.native).toHaveLength(3);
    expect(
      actual.models.map(({ route, coverage }) => [route, coverage.planned]),
    ).toEqual([
      ["provider-a", 2],
      ["provider-b", 1],
    ]);
    expect(
      new Set(
        actual.answers.native.map(
          ({ questionVersion, route }) => `${route}:${questionVersion}`,
        ),
      ),
    ).toEqual(new Set(["provider-a:1", "provider-a:2", "provider-b:1"]));
  });
});

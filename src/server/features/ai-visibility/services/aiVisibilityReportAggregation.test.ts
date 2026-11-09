import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiAnswer, AiResults } from "@/shared/ai-visibility";
import { loadAiVisibilityReportAggregation } from "./aiVisibilityReportAggregation";
import {
  answer,
  nativeResult,
  ownProject,
  projectId,
  request,
  result,
  runId,
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

function setReport(input: {
  result?: AiResults;
  answers?: AiAnswer[];
  project?: { name: string; domain: string };
  competitors?: { name: string | null; domain: string }[];
}) {
  mocks.loadAiFullAnswers.mockResolvedValue({
    result: input.result ?? result(),
    answers: input.answers ?? [],
  });
  mocks.getProject.mockResolvedValue(input.project ?? ownProject);
  mocks.listCompetitors.mockResolvedValue(input.competitors ?? []);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listSections.mockResolvedValue([]);
});

describe("loadAiVisibilityReportAggregation", () => {
  it("uses confirmed search answers as the visibility denominator", async () => {
    const nativeResults = [
      ...Array.from({ length: 6 }, (_, index) =>
        nativeResult({
          id: `confirmed-${index + 1}`,
          eligible: true,
          searchStatus: "completed",
          answer:
            index < 2
              ? `Acme makes a suitable product for question ${index + 1}.`
              : `The answer for question ${index + 1} names another option.`,
          model: "vendor/model-latest",
        }),
      ),
      ...Array.from({ length: 2 }, (_, index) =>
        nativeResult({
          id: `unconfirmed-${index + 1}`,
          eligible: false,
          searchStatus: "unknown",
          answer: "Acme is not confirmed by a search-enabled answer.",
          model: "vendor/model-latest",
        }),
      ),
      nativeResult({
        id: "pending-1",
        status: "pending",
        searchStatus: "pending",
        model: "vendor/model-latest",
      }),
      nativeResult({
        id: "pending-2",
        status: "pending",
        searchStatus: "pending",
        model: "vendor/model-latest",
      }),
    ];
    setReport({
      result: result({
        nativeResults,
        coverage: {
          expected: 10,
          completed: 8,
          noAnswer: 0,
          failed: 0,
          pending: 2,
        },
      }),
    });

    const actual = await loadAiVisibilityReportAggregation(request);

    expect(actual.coverage).toMatchObject({
      planned: 10,
      received: 8,
      evaluable: 6,
      failed: 0,
      pending: 2,
      unevaluable: 2,
      unassignedPending: 0,
      receivedCoverage: { numerator: 8, denominator: 10, percentage: 80 },
      evaluableCoverage: { numerator: 6, denominator: 10, percentage: 60 },
      evaluationRate: { numerator: 6, denominator: 8, percentage: 75 },
    });
    expect(actual.findings[0].mentions.present).toEqual({
      numerator: 2,
      denominator: 6,
      percentage: 33.3,
    });
    expect(actual.findings[0].mentions.absent).toEqual({
      numerator: 4,
      denominator: 6,
      percentage: 66.7,
    });
    expect(actual.search).toEqual({
      confirmed: 6,
      unconfirmed: 2,
      failed: 0,
      pending: 2,
      notReported: 0,
      states: [
        { status: "completed", count: 6 },
        { status: "pending", count: 2 },
        { status: "unknown", count: 2 },
      ],
    });
    expect(actual.models[0].coverage).toMatchObject({
      planned: 10,
      received: 8,
      evaluable: 6,
      failed: 0,
      pending: 2,
    });
    expect(actual.answers.native).toHaveLength(10);
  });

  it("keeps zero denominators null and keeps failures separate from findings", async () => {
    setReport({
      result: result({
        nativeResults: [
          nativeResult({
            id: "failed",
            status: "failed",
            errorCode: "PROVIDER_ERROR",
          }),
          nativeResult({ id: "pending", status: "pending" }),
        ],
        coverage: {
          expected: 2,
          completed: 0,
          noAnswer: 0,
          failed: 1,
          pending: 1,
        },
      }),
    });

    const actual = await loadAiVisibilityReportAggregation(request);

    expect(actual.coverage.receivedCoverage.percentage).toBe(50);
    expect(actual.coverage.evaluableCoverage.percentage).toBe(0);
    expect(actual.coverage.evaluationRate.percentage).toBe(0);
    expect(actual.coverage.failed).toBe(1);
    expect(actual.errors).toEqual([
      expect.objectContaining({
        kind: "native",
        questionId: "question-failed",
        status: "failed",
        code: "PROVIDER_ERROR",
      }),
    ]);
    expect(actual.findings[0].mentions.present.percentage).toBeNull();
    expect(actual.findings[0].mentions.absent.percentage).toBeNull();

    setReport({ result: result() });
    const empty = await loadAiVisibilityReportAggregation(request);
    expect(empty.coverage.receivedCoverage.percentage).toBeNull();
    expect(empty.coverage.evaluableCoverage.percentage).toBeNull();
    expect(empty.coverage.evaluationRate.percentage).toBeNull();
    expect(empty.findings[0].mentions.absent.percentage).toBeNull();
  });

  it("deduplicates question/model attempts and reports same-name identities as ambiguous", async () => {
    const nativeResults = [
      nativeResult({
        id: "primary",
        questionId: "shared-question",
        eligible: true,
        searchStatus: "completed",
        answer: "Mercury announced a new product.",
        model: "vendor/model-a",
        sources: ["https://shop.mercury.example/product"],
      }),
      nativeResult({
        id: "duplicate-attempt",
        questionId: "shared-question",
        eligible: false,
        searchStatus: "unknown",
        answer: "A later unconfirmed attempt.",
        model: "vendor/model-a",
      }),
      nativeResult({
        id: "failed-retry",
        questionId: "shared-question",
        status: "failed",
        errorCode: "RETRY_FAILED",
        model: "vendor/model-a",
      }),
    ];
    setReport({
      result: result({
        nativeResults,
        coverage: {
          expected: 3,
          completed: 2,
          noAnswer: 0,
          failed: 1,
          pending: 0,
        },
      }),
      project: { name: "Mercury", domain: "mercury.example" },
      competitors: [{ name: "Mercury", domain: "shop.mercury.example" }],
    });

    const actual = await loadAiVisibilityReportAggregation(request);

    expect(actual.coverage.planned).toBe(1);
    expect(actual.coverage.evaluable).toBe(1);
    expect(actual.coverage.failed).toBe(0);
    expect(actual.answers.native).toHaveLength(1);
    expect(actual.errors).toEqual([
      expect.objectContaining({ code: "RETRY_FAILED", status: "failed" }),
    ]);
    expect(actual.findings).toHaveLength(2);
    for (const finding of actual.findings) {
      expect(finding.mentions.ambiguous).toEqual({
        numerator: 1,
        denominator: 1,
        percentage: 100,
      });
      expect(finding.mentions.present.percentage).toBeNull();
      expect(finding.mentions.absent.percentage).toBeNull();
      expect(finding.citations.ambiguous.percentage).toBe(100);
    }
  });

  it("excludes a same-name homonym when its source domain identifies another brand", async () => {
    setReport({
      result: result({
        nativeResults: [
          nativeResult({
            id: "homonym",
            eligible: true,
            searchStatus: "completed",
            answer: "Mercury is a good option.",
            sources: ["https://mercury-shop.example/pricing"],
          }),
        ],
        coverage: {
          expected: 1,
          completed: 1,
          noAnswer: 0,
          failed: 0,
          pending: 0,
        },
      }),
      project: { name: "Mercury", domain: "mercury.example" },
      competitors: [{ name: "Mercury", domain: "mercury-shop.example" }],
    });

    const actual = await loadAiVisibilityReportAggregation(request);
    const own = actual.findings.find((finding) => finding.own)!;
    const competitor = actual.findings.find((finding) => !finding.own)!;

    expect(own.mentions.absent).toEqual({
      numerator: 1,
      denominator: 1,
      percentage: 100,
    });
    expect(competitor.mentions.present).toEqual({
      numerator: 1,
      denominator: 1,
      percentage: 100,
    });
    expect(own.citations.absent.percentage).toBe(100);
    expect(competitor.citations.present.percentage).toBe(100);
  });

  it("preserves full legacy answers, question IDs, routes, sources, and errors", async () => {
    const fullAnswer = answer({
      id: "legacy-1",
      text: "Acme offers a product.",
      sources: [
        {
          url: "https://acme.example/pricing",
          domain: "acme.example",
          title: "Pricing",
          position: 1,
        },
      ],
    });
    setReport({
      result: result({
        rows: [],
        coverage: {
          expected: 1,
          completed: 1,
          noAnswer: 0,
          failed: 0,
          pending: 0,
        },
      }),
      answers: [fullAnswer],
    });

    const actual = await loadAiVisibilityReportAggregation(request);

    expect(actual.answers.legacy[0]).toEqual(fullAnswer);
    expect(actual.models[0]).toMatchObject({
      kind: "legacy",
      route: "dataforseo-ai-search",
      coverage: { planned: 1, evaluable: 1 },
    });
    expect(actual.findings[0].mentions.present.percentage).toBe(100);
    expect(actual.findings[0].citations.present.percentage).toBe(100);
  });

  it("does not infer search eligibility for legacy model API answers", async () => {
    setReport({
      result: result({
        coverage: {
          expected: 1,
          completed: 1,
          noAnswer: 0,
          failed: 0,
          pending: 0,
        },
      }),
      answers: [
        answer({ id: "claude-1", engine: "claude", text: "Acme is absent." }),
      ],
    });

    const actual = await loadAiVisibilityReportAggregation(request);

    expect(actual.coverage.received).toBe(1);
    expect(actual.coverage.evaluable).toBe(0);
    expect(actual.search.notReported).toBe(1);
    expect(actual.findings[0].mentions.present.percentage).toBeNull();
    expect(actual.models[0].route).toBe("dataforseo-model-api");
  });

  it("loads only the requested run with all saved results and no paid collection", async () => {
    setReport({ result: result() });

    await loadAiVisibilityReportAggregation(request);

    expect(mocks.loadAiFullAnswers).toHaveBeenCalledWith({
      projectId,
      runId,
      limit: 25,
      topic: null,
      engines: null,
      promptId: null,
      includeHistory: false,
      competitorGap: false,
      branded: "all",
    });
    expect(mocks.getProject).toHaveBeenCalledWith(projectId);
    expect(mocks.listCompetitors).toHaveBeenCalledWith(projectId);
  });
});

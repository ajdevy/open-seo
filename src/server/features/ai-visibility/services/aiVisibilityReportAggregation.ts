import type {
  AiReportRate,
  AiVisibilityReportAggregation,
} from "@/shared/ai-visibility";
import type { AiVisibilityReportAggregationInput } from "@/types/schemas/ai-visibility";
import { AiVisibilityError } from "./aiVisibilityErrors";
import { loadAiPageResults } from "./aiVisibilityResults";
import { loadAiTrend } from "./aiVisibilityTrend";

type PageResults = Awaited<ReturnType<typeof loadAiPageResults>>;

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

function findingsFrom(results: PageResults) {
  return results.summaries.map((summary) => {
    if (
      summary.mentions > summary.answers ||
      summary.citations > summary.answers
    ) {
      throw new AiVisibilityError(
        "INVALID_REPORT_DATA",
        "The saved visibility summaries are inconsistent and cannot be reported.",
      );
    }
    return {
      name: summary.name,
      domain: summary.domain,
      own: summary.own,
      evaluableAnswers: summary.answers,
      mentions: {
        present: rate(summary.mentions, summary.answers),
        absent: rate(summary.answers - summary.mentions, summary.answers),
      },
      citations: {
        present: rate(summary.citations, summary.answers),
        absent: rate(summary.answers - summary.citations, summary.answers),
      },
    };
  });
}

function aggregate(
  results: PageResults,
  trend: Awaited<ReturnType<typeof loadAiTrend>>,
): AiVisibilityReportAggregation {
  if (
    results.appliedFilters.competitorGap ||
    results.truncated ||
    results.rows.length !== results.totalCount
  ) {
    throw new AiVisibilityError(
      "INCOMPLETE_REPORT_DATA",
      "Use the complete, non-gap result set to build report coverage.",
    );
  }

  const planned = results.coverage.expected;
  if (planned !== results.rows.length + results.nativeResults.length) {
    throw new AiVisibilityError(
      "INCOMPLETE_REPORT_DATA",
      "The result rows do not match the planned report coverage.",
    );
  }

  const failed =
    results.rows.filter((row) => row.status === "failed").length +
    results.nativeResults.filter((result) => result.resultStatus === "failed")
      .length;
  const pending =
    results.rows.filter((row) => row.status === "pending").length +
    results.nativeResults.filter(
      (result) =>
        result.resultStatus !== "completed" && result.resultStatus !== "failed",
    ).length;
  const evaluable =
    results.rows.filter(
      (row) => row.status === "completed" && row.answerStatus === "answered",
    ).length +
    results.nativeResults.filter(
      (result) =>
        result.resultStatus === "completed" &&
        result.eligibleForVisibility === true &&
        !!result.answer?.trim(),
    ).length;
  const received = planned - pending;
  if (failed + evaluable > received) {
    throw new AiVisibilityError(
      "INVALID_REPORT_DATA",
      "The result statuses overlap and cannot be reported safely.",
    );
  }

  return {
    coverage: {
      planned,
      // A failed outcome is received; only pending or unrecognized outcomes are not.
      received,
      evaluable,
      failed,
      pending,
      unevaluable: received - failed - evaluable,
      receivedCoverage: rate(received, planned),
      evaluableCoverage: rate(evaluable, planned),
      evaluationRate: rate(evaluable, received),
    },
    // Existing summaries already contain matched answered observations only.
    // Failed and unconfirmed native rows cannot become negative findings here.
    findings: findingsFrom(results),
    trend,
  };
}

/**
 * Combines the existing complete AI results and trend services for a later
 * report consumer. It does not identify native result brands or render reports.
 */
export async function loadAiVisibilityReportAggregation(
  input: AiVisibilityReportAggregationInput,
): Promise<AiVisibilityReportAggregation> {
  if (input.results.projectId !== input.trend.projectId) {
    throw new AiVisibilityError(
      "REPORT_PROJECT_MISMATCH",
      "Choose AI results and trend data from the same project.",
    );
  }

  const [results, trend] = await Promise.all([
    loadAiPageResults({ ...input.results, limit: undefined }),
    loadAiTrend(input.trend),
  ]);
  return aggregate(results, trend);
}

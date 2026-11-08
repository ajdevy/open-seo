import type {
  AiAnswer,
  AiEngine,
  AiNativeResult,
  AiRun,
} from "./ai-visibility";

export interface AiReportRate {
  numerator: number;
  denominator: number;
  percentage: number | null;
}

export interface AiReportCoverage {
  planned: number;
  received: number;
  evaluable: number;
  failed: number;
  pending: number;
  unevaluable: number;
  /** Planned tasks without a persisted result row or a known model route. */
  unassignedPending: number;
  receivedCoverage: AiReportRate;
  evaluableCoverage: AiReportRate;
  evaluationRate: AiReportRate;
}

export interface AiReportBrandMeasure {
  present: AiReportRate;
  absent: AiReportRate;
  ambiguous: AiReportRate;
}

export interface AiReportBrandFinding {
  name: string;
  domain: string;
  own: boolean;
  /** Count of evaluable answers before any ambiguous identities are excluded. */
  evaluableAnswers: number;
  mentions: AiReportBrandMeasure;
  citations: AiReportBrandMeasure;
}

export interface AiReportSearchCoverage {
  confirmed: number;
  unconfirmed: number;
  failed: number;
  pending: number;
  notReported: number;
  states: { status: string; count: number }[];
}

export interface AiReportModel {
  key: string;
  kind: "legacy" | "native";
  model: string;
  route: string;
  engine: AiEngine | null;
  coverage: AiReportCoverage;
  search: AiReportSearchCoverage;
  findings: AiReportBrandFinding[];
}

export interface AiReportError {
  kind: "legacy" | "native";
  model: string;
  route: string;
  questionId: string;
  question: string;
  status: string;
  code: string | null;
  message: string | null;
}

/** A single-run report over stored answer revisions and collection evidence. */
export interface AiVisibilityReportAggregation {
  run: AiRun | null;
  coverage: AiReportCoverage;
  search: AiReportSearchCoverage;
  findings: AiReportBrandFinding[];
  models: AiReportModel[];
  errors: AiReportError[];
  answers: { legacy: AiAnswer[]; native: AiNativeResult[] };
}

import { sort } from "remeda";
import type {
  AiAnswer,
  AiNativeResult,
  AiVisibilityReportAggregation,
} from "@/shared/ai-visibility";
import { aiEngineUsesModelApi, AI_ENGINE_LABELS } from "@/shared/ai-visibility";

type AnswerDetail = {
  key: string;
  model: string;
  route: string;
  question: string;
  revision: string;
  status: string;
  searchStatus: string;
  collectedAt: string | null;
  answer: string | null;
  sources: string[];
  evidence: string[];
  error: string | null;
};

function legacyRoute(answer: AiAnswer) {
  return aiEngineUsesModelApi(answer.observation.engine)
    ? "dataforseo-model-api"
    : "dataforseo-ai-search";
}

function answerDetails(report: AiVisibilityReportAggregation): AnswerDetail[] {
  const legacy = report.answers.legacy.map((answer) => ({
    key: `legacy:${answer.observation.id}`,
    model: AI_ENGINE_LABELS[answer.observation.engine],
    route: legacyRoute(answer),
    question: answer.observation.prompt,
    revision: `Prompt ${answer.observation.promptId}`,
    status: answer.observation.status,
    searchStatus:
      answer.observation.status !== "completed"
        ? answer.observation.status
        : aiEngineUsesModelApi(answer.observation.engine)
          ? "not_reported"
          : "provider_completed",
    collectedAt: answer.observation.collectedAt,
    answer: answer.answerText,
    sources: answer.sources.map((source) => source.url),
    evidence: [],
    error: answer.observation.error,
  }));
  const native = report.answers.native.map((answer: AiNativeResult) => ({
    key: `native:${answer.id}`,
    model: answer.observedModel ?? answer.requestedModel,
    route: answer.route,
    question: answer.question,
    revision: `Question revision ${answer.questionVersion}`,
    status: answer.resultStatus,
    searchStatus: answer.searchStatus,
    collectedAt: answer.collectedAt,
    answer: answer.answer,
    sources: [...new Set([...answer.sources, ...answer.searchSources])],
    evidence: answer.searchEvidence.map(
      (item) => `${item.tool} · ${item.status} · ${item.evidenceRef}`,
    ),
    error: answer.errorCode,
  }));
  return sort(
    [...legacy, ...native],
    (left, right) =>
      (left.collectedAt ?? "").localeCompare(right.collectedAt ?? "") ||
      left.model.localeCompare(right.model) ||
      left.question.localeCompare(right.question),
  );
}

export function AnswerDetails({
  report,
}: {
  report: AiVisibilityReportAggregation;
}) {
  const answers = answerDetails(report);
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        Each item retains its saved question revision, model route, collection
        time, complete answer, search state, and recorded sources.
      </p>
      {answers.map((item) => (
        <details
          key={item.key}
          className="rounded-md border border-border px-3 py-2"
        >
          <summary className="cursor-pointer text-sm">
            <span className="font-medium">{item.model}</span>
            <span className="text-muted-foreground">
              {" "}
              · {item.status} · {item.searchStatus}
            </span>
            <span className="block truncate text-xs text-muted-foreground">
              {item.question}
            </span>
          </summary>
          <div className="mt-3 space-y-2 text-sm">
            <p>
              <span className="font-medium">Question:</span> {item.question}
            </p>
            <p>
              <span className="font-medium">Revision:</span> {item.revision}
            </p>
            <p>
              <span className="font-medium">Route:</span> {item.route}
            </p>
            <p>
              <span className="font-medium">Collected:</span>{" "}
              {item.collectedAt ?? "—"}
            </p>
            <p>
              <span className="font-medium">Search status:</span>{" "}
              {item.searchStatus}
            </p>
            {item.error && (
              <p className="text-destructive">
                <span className="font-medium">Error:</span> {item.error}
              </p>
            )}
            <div>
              <p className="font-medium">Full answer</p>
              <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 font-sans text-xs">
                {item.answer ?? "No answer was saved for this result."}
              </pre>
            </div>
            <div>
              <p className="font-medium">Sources</p>
              {item.sources.length > 0 ? (
                <ul className="list-inside list-disc break-all text-xs">
                  {item.sources.map((source) => (
                    <li key={source}>{source}</li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-muted-foreground">
                  No sources recorded.
                </p>
              )}
            </div>
            {item.evidence.length > 0 && (
              <div>
                <p className="font-medium">Search evidence</p>
                <ul className="list-inside list-disc break-all text-xs">
                  {item.evidence.map((evidence) => (
                    <li key={evidence}>{evidence}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </details>
      ))}
      {answers.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No saved answers for this run.
        </p>
      )}
    </div>
  );
}

import { Badge } from "@/client/components/ui/badge";
import { SafeExternalLink } from "@/client/components/SafeExternalLink";
import type { AiNativeResult } from "@/shared/ai-visibility";
import { aiDate } from "./shared";

export function NativeModelResults({ results }: { results: AiNativeResult[] }) {
  if (!results.length) return null;

  return (
    <section
      aria-label="Native model results"
      className="overflow-hidden rounded-lg border border-border bg-card"
    >
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="text-sm font-medium">Model results</h2>
        <span className="text-xs text-muted-foreground">
          {results.length} saved
        </span>
      </div>
      <ul className="divide-y divide-border">
        {results.map((result) => (
          <li key={result.id} className="space-y-3 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">
                {result.requestedModel}
              </span>
              {result.observedModel &&
                result.observedModel !== result.requestedModel && (
                  <span className="text-xs text-muted-foreground">
                    reported as {result.observedModel}
                  </span>
                )}
              <Badge variant="secondary" size="sm">
                {result.route}
              </Badge>
              <Badge variant="outline" size="sm">
                {result.resultStatus}
              </Badge>
              <Badge variant="outline" size="sm">
                Search: {result.searchStatus}
              </Badge>
              <span className="ml-auto text-xs text-muted-foreground">
                v{result.questionVersion} · {aiDate(result.collectedAt)}
              </span>
            </div>
            <p className="text-xs text-muted-foreground" data-ph-mask>
              {result.question}
            </p>
            <p className="text-xs text-muted-foreground">
              Task ID: <code>{result.id}</code>
            </p>
            {result.resultStatus === "pending" ? (
              <p className="text-sm text-muted-foreground">
                Waiting for a result for this model.
              </p>
            ) : result.answer ? (
              <p className="whitespace-pre-wrap text-sm" data-ph-mask>
                {result.answer}
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                No answer was captured.
              </p>
            )}
            {!!result.errorCode && (
              <p className="text-xs text-destructive">{result.errorCode}</p>
            )}
            {(result.sources.length > 0 ||
              result.searchSources.length > 0 ||
              result.searchEvidence.length > 0) && (
              <details className="text-xs">
                <summary className="cursor-pointer text-muted-foreground">
                  Sources and search evidence
                </summary>
                <div className="mt-3 grid gap-3 sm:grid-cols-3">
                  <SourceList title="Citations" sources={result.sources} />
                  <SourceList
                    title="Search sources"
                    sources={result.searchSources}
                  />
                  <div className="space-y-1">
                    <h3 className="font-medium">Evidence</h3>
                    {result.searchEvidence.length ? (
                      <ul className="space-y-1 text-muted-foreground">
                        {result.searchEvidence.map((item, index) => (
                          <li key={`${item.evidenceRef}-${index}`}>
                            {item.tool} · {item.status} · {item.evidenceRef}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-muted-foreground">None recorded.</p>
                    )}
                  </div>
                </div>
              </details>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function SourceList({ title, sources }: { title: string; sources: string[] }) {
  return (
    <div className="space-y-1">
      <h3 className="font-medium">{title}</h3>
      {sources.length ? (
        <ul className="space-y-1 text-muted-foreground">
          {sources.map((source, index) => (
            <li key={`${source}-${index}`} className="break-all">
              <SafeExternalLink
                url={source}
                label={source}
                className="hover:text-primary hover:underline"
              />
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground">None recorded.</p>
      )}
    </div>
  );
}

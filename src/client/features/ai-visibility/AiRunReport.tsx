import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@/client/components/ui/skeleton";
import type { AiVisibilityReportAggregation } from "@/shared/ai-visibility";
import { AiQueryError, aiRunReportQueryOptions } from "./shared";
import { AnswerDetails } from "./AiRunReportAnswers";
import {
  CoverageTable,
  FindingTable,
  SearchCoverage,
} from "./AiRunReportMetrics";

function ReportContent({ report }: { report: AiVisibilityReportAggregation }) {
  return (
    <div className="space-y-5">
      <section className="space-y-2">
        <h3 className="text-sm font-medium">Coverage</h3>
        <CoverageTable report={report} />
        {report.coverage.unassignedPending > 0 && (
          <p className="text-xs text-muted-foreground">
            {report.coverage.unassignedPending} pending task(s) have no saved
            model/route row yet.
          </p>
        )}
      </section>
      <section className="space-y-2">
        <h3 className="text-sm font-medium">Brand mentions and citations</h3>
        <FindingTable report={report} />
      </section>
      <section className="space-y-2">
        <h3 className="text-sm font-medium">Search coverage</h3>
        <SearchCoverage report={report} />
      </section>
      <section className="space-y-2">
        <h3 className="text-sm font-medium">Errors</h3>
        {report.errors.length === 0 ? (
          <p className="text-sm text-muted-foreground">No collection errors.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {report.errors.map((error, index) => (
              <li
                key={`${error.kind}:${error.questionId}:${index}`}
                className="rounded-md border border-border px-3 py-2"
              >
                <span className="font-medium">
                  {error.model} · {error.route} · {error.status}
                </span>
                {error.code && <span> · {error.code}</span>}
                <p className="text-xs text-muted-foreground">
                  {error.question}
                </p>
                {error.message && (
                  <p className="text-xs text-destructive">{error.message}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="space-y-2">
        <h3 className="text-sm font-medium">Question answers</h3>
        <AnswerDetails report={report} />
      </section>
    </div>
  );
}

export function AiRunReport({
  projectId,
  runId,
}: {
  projectId: string;
  runId: string | undefined;
}) {
  const query = useQuery(aiRunReportQueryOptions(projectId, runId));
  if (!runId) return null;
  return (
    <section className="mx-4 mb-4 space-y-3 rounded-lg border border-border p-3">
      <div>
        <h2 className="text-sm font-semibold">Run report</h2>
        <p className="text-xs text-muted-foreground">
          Aggregated from saved results; opening this report does not run
          models.
        </p>
      </div>
      {query.isPending && <Skeleton className="h-24 w-full" />}
      {query.isError && (
        <AiQueryError
          error={query.error}
          retry={() => {
            void query.refetch();
          }}
        />
      )}
      {query.data && <ReportContent report={query.data} />}
    </section>
  );
}

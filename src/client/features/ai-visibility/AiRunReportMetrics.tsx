import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/client/components/ui/table";
import type {
  AiReportRate,
  AiVisibilityReportAggregation,
} from "@/shared/ai-visibility";

function percent(value: number | null) {
  return value === null ? "—" : `${value.toFixed(1)}%`;
}

function rateLabel(rate: AiReportRate) {
  return `${rate.numerator}/${rate.denominator} (${percent(rate.percentage)})`;
}

function countRate(count: number, total: number) {
  return rateLabel({
    numerator: count,
    denominator: total,
    percentage: total === 0 ? null : Math.round((count / total) * 1000) / 10,
  });
}

export function CoverageTable({
  report,
}: {
  report: AiVisibilityReportAggregation;
}) {
  const rows = [
    { key: "overall", label: "All models", coverage: report.coverage },
    ...report.models.map((model) => ({
      key: model.key,
      label: `${model.model} · ${model.route}`,
      coverage: model.coverage,
    })),
  ];
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Scope</TableHead>
            <TableHead>Planned</TableHead>
            <TableHead>Received</TableHead>
            <TableHead>Evaluable</TableHead>
            <TableHead>Failed</TableHead>
            <TableHead>Pending</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.key}>
              <TableCell className="font-medium">{row.label}</TableCell>
              <TableCell>{row.coverage.planned}</TableCell>
              <TableCell>{rateLabel(row.coverage.receivedCoverage)}</TableCell>
              <TableCell>{rateLabel(row.coverage.evaluableCoverage)}</TableCell>
              <TableCell>
                {countRate(row.coverage.failed, row.coverage.planned)}
              </TableCell>
              <TableCell>
                {countRate(row.coverage.pending, row.coverage.planned)}
                {row.coverage.unassignedPending > 0 && (
                  <span className="ml-1 text-muted-foreground">
                    ({row.coverage.unassignedPending} unassigned)
                  </span>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export function FindingTable({
  report,
}: {
  report: AiVisibilityReportAggregation;
}) {
  const rows = [
    ...report.findings.map((finding) => ({
      key: `overall:${finding.domain}`,
      scope: "All models",
      finding,
    })),
    ...report.models.flatMap((model) =>
      model.findings.map((finding) => ({
        key: `${model.key}:${finding.domain}`,
        scope: model.model,
        finding,
      })),
    ),
  ];
  if (rows.length === 0) return null;
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Scope / brand</TableHead>
            <TableHead>Mentions</TableHead>
            <TableHead>Absence</TableHead>
            <TableHead>Ambiguous mention</TableHead>
            <TableHead>Citations</TableHead>
            <TableHead>No citation</TableHead>
            <TableHead>Ambiguous citation</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map(({ key, scope, finding }) => (
            <TableRow key={key}>
              <TableCell>
                <div className="font-medium">
                  {scope} · {finding.name}
                </div>
                <div className="text-xs text-muted-foreground">
                  {finding.domain}
                  {finding.own ? " · own brand" : ""}
                </div>
              </TableCell>
              <TableCell>{rateLabel(finding.mentions.present)}</TableCell>
              <TableCell>{rateLabel(finding.mentions.absent)}</TableCell>
              <TableCell>{rateLabel(finding.mentions.ambiguous)}</TableCell>
              <TableCell>{rateLabel(finding.citations.present)}</TableCell>
              <TableCell>{rateLabel(finding.citations.absent)}</TableCell>
              <TableCell>{rateLabel(finding.citations.ambiguous)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export function SearchCoverage({
  report,
}: {
  report: AiVisibilityReportAggregation;
}) {
  const rows = [
    { key: "overall", label: "All models", search: report.search },
    ...report.models.map((model) => ({
      key: model.key,
      label: `${model.model} · ${model.route}`,
      search: model.search,
    })),
  ];
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Scope</TableHead>
            <TableHead>Confirmed search</TableHead>
            <TableHead>Unconfirmed</TableHead>
            <TableHead>Not reported</TableHead>
            <TableHead>Failed</TableHead>
            <TableHead>Pending</TableHead>
            <TableHead>Provider states</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map(({ key, label, search }) => (
            <TableRow key={key}>
              <TableCell className="font-medium">{label}</TableCell>
              <TableCell>{search.confirmed}</TableCell>
              <TableCell>{search.unconfirmed}</TableCell>
              <TableCell>{search.notReported}</TableCell>
              <TableCell>{search.failed}</TableCell>
              <TableCell>{search.pending}</TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {search.states
                  .map(({ status, count }) => `${status}: ${count}`)
                  .join(" · ") || "—"}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

import {
  aiBrandNames,
  aiMentionSpans,
  ownedAiDomain,
} from "./aiVisibilityMatching";
import type {
  AiAnswer,
  AiBrand,
  AiNativeResult,
  AiReportBrandFinding,
  AiReportRate,
} from "@/shared/ai-visibility";

type MatchStatus = "present" | "absent" | "ambiguous";
type ReportEntry =
  | { kind: "legacy"; evaluable: boolean; answer: AiAnswer }
  | { kind: "native"; evaluable: boolean; result: AiNativeResult };

function answerText(entry: ReportEntry): string | null {
  return entry.kind === "legacy"
    ? entry.answer.answerText
    : entry.result.answer;
}

function answerSources(entry: ReportEntry): string[] {
  return entry.kind === "legacy"
    ? entry.answer.sources.map((source) => source.domain)
    : entry.result.sources;
}

function sourceHost(value: string): string | null {
  try {
    return new URL(value).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    try {
      return new URL(`https://${value}`).hostname
        .toLowerCase()
        .replace(/^www\./, "");
    } catch {
      return null;
    }
  }
}

function normalizedName(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .trim()
    .toLocaleLowerCase();
}

function mentionStatus(
  entry: ReportEntry,
  brand: AiBrand,
  brands: AiBrand[],
): MatchStatus {
  const text = answerText(entry);
  if (!text) return "absent";

  const domainMentioned =
    aiMentionSpans(text, [brand.domain]).length > 0 ||
    aiBrandNames(brand).some(
      (name) =>
        normalizedName(name) !== normalizedName(brand.name) &&
        normalizedName(name) !== normalizedName(brand.domain) &&
        aiMentionSpans(text, [name]).length > 0,
    );
  if (domainMentioned) return "present";

  const nameMentioned = aiMentionSpans(text, [brand.name]).length > 0;
  if (!nameMentioned) return "absent";

  const sameName = brands.filter(
    (candidate) =>
      normalizedName(candidate.name) === normalizedName(brand.name) &&
      normalizedName(candidate.domain) !== normalizedName(brand.domain),
  );
  if (!sameName.length) return "present";

  const sourceHosts = answerSources(entry)
    .map(sourceHost)
    .filter((host): host is string => !!host);
  const sourceMatchedNames = brands.filter(
    (candidate) =>
      normalizedName(candidate.name) === normalizedName(brand.name) &&
      sourceHosts.some((host) => ownedAiDomain(host, candidate.domain)),
  );
  if (sourceMatchedNames.length === 1) {
    return normalizedName(sourceMatchedNames[0].domain) ===
      normalizedName(brand.domain)
      ? "present"
      : "absent";
  }
  return "ambiguous";
}

function citationStatus(
  entry: ReportEntry,
  brand: AiBrand,
  brands: AiBrand[],
): MatchStatus {
  const hosts = answerSources(entry)
    .map(sourceHost)
    .filter((host): host is string => !!host);
  if (!hosts.some((host) => ownedAiDomain(host, brand.domain))) return "absent";

  const overlappingIdentities = brands.filter((candidate) =>
    hosts.some(
      (host) =>
        ownedAiDomain(host, candidate.domain) &&
        ownedAiDomain(host, brand.domain),
    ),
  );
  return overlappingIdentities.length > 1 ? "ambiguous" : "present";
}

function rate(numerator: number, denominator: number): AiReportRate {
  return {
    numerator,
    denominator,
    percentage:
      denominator === 0
        ? null
        : Math.round((numerator / denominator) * 1000) / 10,
  };
}

function measure(statuses: MatchStatus[]) {
  const ambiguous = statuses.filter((status) => status === "ambiguous").length;
  const confirmedDenominator = statuses.length - ambiguous;
  return {
    present: rate(
      statuses.filter((status) => status === "present").length,
      confirmedDenominator,
    ),
    absent: rate(
      statuses.filter((status) => status === "absent").length,
      confirmedDenominator,
    ),
    ambiguous: rate(ambiguous, statuses.length),
  };
}

export function findingsFor(
  entries: ReportEntry[],
  brands: AiBrand[],
): AiReportBrandFinding[] {
  const evaluable = entries.filter((entry) => entry.evaluable);
  return brands.map((brand) => {
    const mentionStatuses = evaluable.map((entry) =>
      mentionStatus(entry, brand, brands),
    );
    const citationStatuses = evaluable.map((entry) =>
      citationStatus(entry, brand, brands),
    );
    return {
      name: brand.name,
      domain: brand.domain,
      own: brand.own,
      evaluableAnswers: evaluable.length,
      mentions: measure(mentionStatuses),
      citations: measure(citationStatuses),
    };
  });
}

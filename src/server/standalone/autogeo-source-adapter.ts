import { z } from "zod";
import {
  AUTOGEO_SOURCE_CONTRACT_REVISION,
  classifyAutoGeoSourcePaths,
  parseAutoGeoSourceRows,
} from "./autogeo-source-contract";
import { prepareAutoGeoMappings } from "./autogeo-source-adapter-mapping";
import {
  mappingSchema,
  type AutoGeoMapping,
} from "./autogeo-source-adapter-schema";
import {
  ClientRestoreError,
  clientRestoreArchiveSchema,
  payloadSchema,
  sha256Json,
  type ClientRestorePayload,
} from "./client-restore-schema";
import { validatePayload } from "./client-restore-validate";

export { AUTOGEO_SOURCE_CONTRACT_REVISION };

type RestoreArchive = z.infer<typeof clientRestoreArchiveSchema>;

export type AutoGeoRestorePlan = {
  canImport: false;
  mappingEvidenceRef: string | null;
  archive: RestoreArchive | null;
  archiveArtifacts: Record<string, Uint8Array>;
  report: {
    discoveredPrompts: number;
    mappedPrompts: number;
    unmappedPrompts: number;
    discoveredAnswers: number;
    mappedAnswers: number;
    unmappedAnswers: number;
    archiveOnlyArtifactFiles: number;
    blockers: string[];
  };
};

function emptyPayload(sourceOrganizationId: string): ClientRestorePayload {
  return {
    sourceOrganizationId,
    projects: [],
    projectContextSections: [],
    projectCompetitors: [],
    projectKeyPages: [],
    projectResearchLog: [],
    aiTrackers: [],
    aiPrompts: [],
    aiRuns: [],
    aiObservations: [],
    aiSources: [],
    aiMatches: [],
    aiNativeResults: [],
    aiNativeSources: [],
    aiNativeSearchSources: [],
    aiNativeSearchEvidence: [],
  };
}

function copyArchiveArtifacts(
  artifacts: Record<string, Uint8Array>,
  paths: string[],
): Record<string, Uint8Array> {
  const copies: Record<string, Uint8Array> = {};
  for (const path of paths) {
    const value = artifacts[path];
    if (!(value instanceof Uint8Array))
      throw new Error("source artifact must be bytes");
    Object.defineProperty(copies, path, {
      value: new Uint8Array(value),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return copies;
}

function emptyReport(
  blockers: string[],
  archiveOnlyArtifactFiles: number,
): AutoGeoRestorePlan["report"] {
  return {
    discoveredPrompts: 0,
    mappedPrompts: 0,
    unmappedPrompts: 0,
    discoveredAnswers: 0,
    mappedAnswers: 0,
    unmappedAnswers: 0,
    archiveOnlyArtifactFiles,
    blockers,
  };
}

function sourceOrganizationIdForMapping(value: unknown): string {
  if (
    typeof value === "object" &&
    value !== null &&
    "clientRef" in value &&
    typeof value.clientRef === "string"
  )
    return `autogeo:${value.clientRef}`;
  return "autogeo:unmapped";
}

function mappedPayload(
  mapping: AutoGeoMapping,
  sourceOrgId: string,
  prepared: ReturnType<typeof prepareAutoGeoMappings>,
): ClientRestorePayload {
  return payloadSchema.parse({
    ...emptyPayload(sourceOrgId),
    projects: mapping.projects
      .filter((row) => prepared.projectIds.has(row.id))
      .map((row) => ({
        id: row.id,
        organizationId: sourceOrgId,
        name: row.name,
        domain: row.domain,
        locationCode: row.locationCode,
        languageCode: row.languageCode,
        createdAt: row.createdAt,
        archivedAt: row.archivedAt,
        aiResearchKeywords: row.aiResearchKeywords,
      })),
    aiTrackers: mapping.trackers
      .filter((row) => prepared.trackerIds.has(row.id))
      .map((row) => ({
        ...row,
        enabled: false,
        chatgpt: false,
        gemini: false,
        claude: false,
        perplexity: false,
        googleAiOverview: false,
        nextCheckAt: null,
        lastSkipReason: "historical_import_disabled",
      })),
    aiPrompts: prepared.prompts.rows,
    aiRuns: [...prepared.answers.runs.values()],
    aiNativeResults: prepared.answers.results,
    aiNativeSources: prepared.answers.sources,
  });
}

async function buildArchive(
  mapping: AutoGeoMapping,
  payload: ClientRestorePayload,
): Promise<RestoreArchive> {
  validatePayload(payload);
  return clientRestoreArchiveSchema.parse({
    format: "openseo-client-restore",
    version: 1,
    exportedAt: mapping.exportedAt,
    contentSha256: await sha256Json(payload),
    recovery: {
      activeRunsClosed: 0,
      unconfirmedObservationsNotReplayed: 0,
      unconfirmedNativeResultsNotReplayed: 0,
    },
    payload,
  });
}

function sortedBlockers(blockers: Set<string>): string[] {
  const values = [...blockers];
  // oxlint-disable-next-line unicorn/no-array-sort
  values.sort();
  return values;
}

function unmappedPlan(
  mappingEvidenceRef: string | null,
  archiveArtifacts: Record<string, Uint8Array>,
  blockers: string[],
  archiveOnlyArtifactFiles: number,
): AutoGeoRestorePlan {
  return {
    canImport: false,
    mappingEvidenceRef,
    archive: null,
    archiveArtifacts,
    report: emptyReport(blockers, archiveOnlyArtifactFiles),
  };
}

/**
 * Prepare an OpenSEO restore archive from caller-supplied AutoGeo bytes.
 *
 * This pure adapter never reads a source workspace, writes the database, calls
 * the importer, or authorizes a migration. Every source file is returned
 * unchanged for a separate encrypted archive handoff. Evidence references
 * are not verified here and canImport intentionally remains false.
 */
export async function prepareAutoGeoClientRestore(
  artifacts: Record<string, Uint8Array>,
  rawMapping: unknown,
): Promise<AutoGeoRestorePlan> {
  const paths = Object.keys(artifacts);
  const classified = classifyAutoGeoSourcePaths(paths);
  const archiveArtifacts = copyArchiveArtifacts(artifacts, paths);
  const sourceOrgId = sourceOrganizationIdForMapping(rawMapping);
  const mapping = mappingSchema.safeParse(rawMapping);
  const archiveOnlyArtifactFiles = classified.filter(
    (file) => file.kind !== "prompt" && file.kind !== "answers",
  ).length;
  if (!mapping.success)
    return unmappedPlan(
      null,
      archiveArtifacts,
      ["invalid_reviewed_mapping"],
      archiveOnlyArtifactFiles,
    );

  let source;
  try {
    source = parseAutoGeoSourceRows(artifacts, classified);
  } catch {
    return unmappedPlan(
      mapping.data.mappingEvidenceRef,
      archiveArtifacts,
      ["invalid_source_contract"],
      archiveOnlyArtifactFiles,
    );
  }

  const prepared = prepareAutoGeoMappings(source, mapping.data, sourceOrgId);
  const unmappedPrompts = source.prompts.length - prepared.prompts.rows.length;
  const unmappedAnswers =
    prepared.answers.discoveredCount - prepared.answers.mappedCount;
  if (unmappedPrompts > 0)
    prepared.blockers.add("unmapped_prompt_rows_archived");
  if (unmappedAnswers > 0)
    prepared.blockers.add("unmapped_answer_rows_archived");

  let archive: RestoreArchive | null = null;
  // A history can contain prompts before its first answer run, but never emit a
  // partial target archive when any supported source row lacks a mapping.
  const hasMappedRows =
    prepared.prompts.rows.length > 0 || prepared.answers.results.length > 0;
  if (
    prepared.projectIds.size > 0 &&
    hasMappedRows &&
    unmappedPrompts === 0 &&
    unmappedAnswers === 0
  ) {
    try {
      archive = await buildArchive(
        mapping.data,
        mappedPayload(mapping.data, sourceOrgId, prepared),
      );
    } catch (error) {
      if (error instanceof ClientRestoreError || error instanceof z.ZodError)
        prepared.blockers.add("mapped_payload_failed_validation");
      else throw error;
    }
  }

  return {
    canImport: false,
    mappingEvidenceRef: mapping.data.mappingEvidenceRef,
    archive,
    archiveArtifacts,
    report: {
      discoveredPrompts: source.prompts.length,
      mappedPrompts: prepared.prompts.rows.length,
      unmappedPrompts,
      discoveredAnswers: prepared.answers.discoveredCount,
      mappedAnswers: prepared.answers.mappedCount,
      unmappedAnswers,
      archiveOnlyArtifactFiles,
      blockers: sortedBlockers(prepared.blockers),
    },
  };
}

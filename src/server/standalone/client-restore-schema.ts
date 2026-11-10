import { z } from "zod";

const projectRow = z
  .object({
    id: z.string(),
    organizationId: z.string(),
    name: z.string(),
    domain: z.string().nullable(),
    locationCode: z.number(),
    languageCode: z.string(),
    createdAt: z.string(),
    archivedAt: z.string().nullable(),
    aiResearchKeywords: z.string().nullable(),
    indexnowKey: z.string().nullable(),
  })
  .strict();
const projectContextRow = z
  .object({
    projectId: z.string(),
    key: z.string(),
    title: z.string().nullable(),
    content: z.string(),
    updatedAt: z.string(),
    updatedBy: z.enum(["user", "sam", "mcp"]),
  })
  .strict();
const competitorRow = z
  .object({
    id: z.string(),
    projectId: z.string(),
    domain: z.string(),
    name: z.string().nullable(),
    notes: z.string().nullable(),
    updatedAt: z.string(),
    updatedBy: z.enum(["user", "sam", "mcp"]),
  })
  .strict();
const keyPageRow = z
  .object({
    id: z.string(),
    projectId: z.string(),
    url: z.string(),
    role: z.enum(["hub", "spoke", "money", "other"]),
    topic: z.string().nullable(),
    notes: z.string().nullable(),
    updatedAt: z.string(),
    updatedBy: z.enum(["user", "sam", "mcp"]),
  })
  .strict();
const researchLogRow = z
  .object({
    id: z.string(),
    projectId: z.string(),
    entryDate: z.string(),
    summary: z.string(),
    createdBy: z.enum(["user", "sam", "mcp"]),
    createdAt: z.string(),
  })
  .strict();
const trackerRow = z
  .object({
    id: z.string(),
    projectId: z.string(),
    enabled: z.boolean(),
    chatgpt: z.boolean(),
    gemini: z.boolean(),
    claude: z.boolean(),
    perplexity: z.boolean(),
    googleAiOverview: z.boolean(),
    locationCode: z.number(),
    languageCode: z.string(),
    scheduleInterval: z.enum(["daily", "weekly", "monthly"]),
    nextCheckAt: z.string().nullable(),
    lastSkipReason: z.string().nullable(),
    createdAt: z.string(),
  })
  .strict();
const promptRow = z
  .object({
    id: z.string(),
    trackerId: z.string(),
    topic: z.string(),
    text: z.string(),
    paused: z.boolean(),
    archived: z.boolean(),
    createdAt: z.string(),
  })
  .strict();
const runRow = z
  .object({
    id: z.string(),
    trackerId: z.string(),
    projectId: z.string(),
    trigger: z.enum(["baseline", "scheduled", "manual"]),
    status: z.enum(["queued", "running", "completed", "partial", "failed"]),
    locationCode: z.number(),
    languageCode: z.string(),
    createdAt: z.string(),
    completedAt: z.string().nullable(),
  })
  .strict();
const observationRow = z
  .object({
    id: z.string(),
    runId: z.string(),
    promptId: z.string(),
    engine: z.enum([
      "chatgpt",
      "gemini",
      "google_ai_overview",
      "claude",
      "perplexity",
    ]),
    branded: z.boolean(),
    status: z.enum(["pending", "completed", "failed"]),
    collectedAt: z.string().nullable(),
    answerMarkdown: z.string().nullable(),
    error: z.string().nullable(),
  })
  .strict();
const sourceRow = z
  .object({
    id: z.string(),
    observationId: z.string(),
    url: z.string(),
    domain: z.string(),
    title: z.string().nullable(),
    position: z.number(),
  })
  .strict();
const matchRow = z
  .object({
    id: z.string(),
    observationId: z.string(),
    name: z.string(),
    domain: z.string(),
    own: z.boolean(),
    mentioned: z.boolean(),
    cited: z.boolean(),
    firstMention: z.number().nullable(),
  })
  .strict();
const nativeResultRow = z
  .object({
    id: z.string(),
    schemaVersion: z.number(),
    clientId: z.string(),
    projectId: z.string(),
    runId: z.string(),
    questionId: z.string(),
    questionVersion: z.number(),
    questionSnapshot: z.string(),
    requestedModel: z.string(),
    observedModel: z.string().nullable(),
    route: z.string(),
    resultStatus: z.string(),
    answer: z.string().nullable(),
    searchStatus: z.string(),
    eligibleForVisibility: z.boolean().nullable(),
    errorCode: z.string().nullable(),
    turnStatus: z.string().nullable(),
    collectedAt: z.string(),
    finalizationToken: z.string().nullable(),
  })
  .strict();
const nativeSourceRow = z
  .object({
    id: z.string(),
    resultId: z.string(),
    value: z.string(),
    position: z.number(),
  })
  .strict();
const nativeEvidenceRow = z
  .object({
    id: z.string(),
    resultId: z.string(),
    tool: z.string(),
    status: z.string(),
    evidenceRef: z.string(),
    position: z.number(),
  })
  .strict();

export const payloadSchema = z
  .object({
    sourceOrganizationId: z.string().min(1),
    projects: z.array(projectRow),
    projectContextSections: z.array(projectContextRow),
    projectCompetitors: z.array(competitorRow),
    projectKeyPages: z.array(keyPageRow),
    projectResearchLog: z.array(researchLogRow),
    aiTrackers: z.array(trackerRow),
    aiPrompts: z.array(promptRow),
    aiRuns: z.array(runRow),
    aiObservations: z.array(observationRow),
    aiSources: z.array(sourceRow),
    aiMatches: z.array(matchRow),
    aiNativeResults: z.array(nativeResultRow),
    aiNativeSources: z.array(nativeSourceRow),
    aiNativeSearchSources: z.array(nativeSourceRow),
    aiNativeSearchEvidence: z.array(nativeEvidenceRow),
  })
  .strict();

export const clientRestoreArchiveSchema = z
  .object({
    format: z.literal("openseo-client-restore"),
    version: z.literal(1),
    exportedAt: z.string().datetime(),
    contentSha256: z.string().regex(/^[a-f0-9]{64}$/),
    recovery: z
      .object({
        activeRunsClosed: z.number().int().nonnegative(),
        unconfirmedObservationsNotReplayed: z.number().int().nonnegative(),
        unconfirmedNativeResultsNotReplayed: z.number().int().nonnegative(),
      })
      .strict(),
    payload: payloadSchema,
  })
  .strict();

export type ClientRestorePayload = z.infer<typeof payloadSchema>;

export class ClientRestoreError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function ordered<T extends object>(
  rows: T[],
  key: (row: T) => string,
): T[] {
  const copy = [...rows];
  // ES2022 is the configured library target, so sort a copy instead of using ES2023 toSorted.
  // oxlint-disable-next-line unicorn/no-array-sort
  copy.sort((a, b) => key(a).localeCompare(key(b)));
  return copy;
}

export function relationKey(row: {
  projectId: string;
  id?: string;
  key?: string;
}) {
  return `${row.projectId}\0${row.id ?? row.key ?? ""}`;
}

export function ids<T>(rows: T[], getId: (row: T) => string): string[] {
  return rows.map(getId);
}

export async function sha256Json(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function assertUniqueIds<T>(
  rows: T[],
  getId: (row: T) => string,
  table: string,
) {
  const seen = new Set<string>();
  for (const row of rows) {
    const id = getId(row);
    if (seen.has(id))
      throw new ClientRestoreError(400, `Duplicate ${table} id`);
    seen.add(id);
  }
  return seen;
}

export function assertProjectScopedRows<
  T extends { id: string; projectId: string },
>(rows: T[], table: string, projectIds: Set<string>) {
  assertUniqueIds(rows, (row) => row.id, table);
  if (rows.some((row) => !projectIds.has(row.projectId)))
    throw new ClientRestoreError(
      400,
      "Snapshot contains a cross-client project relation",
    );
}

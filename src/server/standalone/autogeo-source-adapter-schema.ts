import { z } from "zod";
import { AUTOGEO_SOURCE_CONTRACT_REVISION } from "./autogeo-source-contract";

const nonblank = z.string().refine((value) => value.trim().length > 0);
const projectMappingSchema = z
  .object({
    id: nonblank,
    name: nonblank,
    domain: z.string().nullable(),
    locationCode: z.number().int(),
    languageCode: nonblank,
    createdAt: z.string().datetime(),
    archivedAt: z.string().datetime().nullable(),
    aiResearchKeywords: z.string().nullable(),
  })
  .strict();
const trackerMappingSchema = z
  .object({
    id: nonblank,
    projectId: nonblank,
    locationCode: z.number().int(),
    languageCode: nonblank,
    scheduleInterval: z.enum(["daily", "weekly", "monthly"]),
    createdAt: z.string().datetime(),
  })
  .strict();
const promptMappingSchema = z
  .object({
    id: nonblank,
    trackerId: nonblank,
    topic: nonblank,
    createdAt: z.string().datetime(),
  })
  .strict();
const runMappingSchema = z
  .object({
    trackerId: nonblank,
    projectId: nonblank,
    trigger: z.enum(["baseline", "scheduled", "manual"]),
    status: z.enum(["queued", "running", "completed", "partial", "failed"]),
    locationCode: z.number().int(),
    languageCode: nonblank,
    createdAt: z.string().datetime(),
    completedAt: z.string().datetime(),
  })
  .strict();
const answerMappingSchema = z
  .object({
    sourceStatus: nonblank,
    sourceProvider: nonblank,
    engine: z.enum([
      "chatgpt",
      "gemini",
      "google_ai_overview",
      "claude",
      "perplexity",
    ]),
    resultStatus: z.enum(["pending", "completed", "failed"]),
    collectedAt: z.string().datetime(),
    confirmedCitationIndexes: z.array(z.number().int().nonnegative()),
  })
  .strict();

export const mappingSchema = z
  .object({
    clientRef: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/),
    mappingEvidenceRef: z.string().regex(/^[A-Za-z0-9_.:/-]{1,240}$/),
    sourceContractRevision: z.literal(AUTOGEO_SOURCE_CONTRACT_REVISION),
    exportedAt: z.string().datetime(),
    projects: z.array(projectMappingSchema),
    trackers: z.array(trackerMappingSchema),
    promptMappings: z.record(z.string(), promptMappingSchema),
    runMappings: z.record(z.string(), runMappingSchema),
    answerMappings: z.record(z.string(), answerMappingSchema),
  })
  .strict();

export type AutoGeoMapping = z.infer<typeof mappingSchema>;

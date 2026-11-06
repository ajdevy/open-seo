import { z } from "zod";

export const aiNativeSearchEvidenceSchema = z.object({
  tool: z.string().min(1),
  status: z.string().min(1),
  evidence_ref: z.string().min(1),
});

/** Storage contract for one model and route result. Status values stay open. */
export const aiNativeResultSchema = z.object({
  schema_version: z.number().int().positive(),
  client_id: z.string().min(1),
  project_id: z.string().min(1),
  run_id: z.string().min(1),
  question_id: z.string().min(1),
  question_version: z.number().int().positive(),
  result_id: z.string().min(1),
  timestamp: z.string().min(1),
  question: z.string().min(1),
  requested_model: z.string().min(1),
  observed_model: z.string().min(1).nullable().optional(),
  route: z.string().min(1),
  result_status: z.string().min(1),
  answer: z.string().nullable(),
  search_status: z.string().min(1),
  search_evidence: z.array(aiNativeSearchEvidenceSchema),
  search_sources: z.array(z.string().min(1)),
  sources: z.array(z.string().min(1)),
  eligible_for_visibility: z.boolean().nullable(),
  error_code: z.string().min(1).nullable().optional(),
  turn_status: z.string().min(1).nullable().optional(),
});

export type AiNativeResultInput = z.infer<typeof aiNativeResultSchema>;

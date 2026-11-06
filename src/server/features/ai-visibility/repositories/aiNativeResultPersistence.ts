import { and, eq, exists, isNull, sql } from "drizzle-orm";
import type { runBatch } from "@/db/runBatch";
import {
  aiNativeResults,
  aiNativeSearchEvidence,
  aiNativeSearchSources,
  aiNativeSources,
} from "@/db/schema";
import type { AiNativeResultInput } from "@/types/schemas/ai-native-results";

type BatchExecutor = Parameters<Parameters<typeof runBatch>[0]>[0];

export function nativeResultRow(input: AiNativeResultInput) {
  return {
    id: input.result_id,
    schemaVersion: input.schema_version,
    clientId: input.client_id,
    projectId: input.project_id,
    runId: input.run_id,
    questionId: input.question_id,
    questionVersion: input.question_version,
    questionSnapshot: input.question,
    requestedModel: input.requested_model,
    observedModel: input.observed_model ?? null,
    route: input.route,
    resultStatus: input.result_status,
    answer: input.answer,
    searchStatus: input.search_status,
    eligibleForVisibility: input.eligible_for_visibility,
    errorCode: input.error_code ?? null,
    turnStatus: input.turn_status ?? null,
    collectedAt: input.timestamp,
  };
}

function resultWriteGuard(
  tx: BatchExecutor,
  resultId: string,
  finalizationToken: string | null,
) {
  return exists(
    tx
      .select({ id: aiNativeResults.id })
      .from(aiNativeResults)
      .where(
        and(
          eq(aiNativeResults.id, resultId),
          finalizationToken === null
            ? isNull(aiNativeResults.finalizationToken)
            : eq(aiNativeResults.finalizationToken, finalizationToken),
        ),
      ),
  );
}

function relationRows(input: AiNativeResultInput) {
  return {
    sources: input.sources.map((value, index) => ({
      id: crypto.randomUUID(),
      resultId: input.result_id,
      value,
      position: index + 1,
    })),
    searchSources: input.search_sources.map((value, index) => ({
      id: crypto.randomUUID(),
      resultId: input.result_id,
      value,
      position: index + 1,
    })),
    evidence: input.search_evidence.map((item, index) => ({
      id: crypto.randomUUID(),
      resultId: input.result_id,
      tool: item.tool,
      status: item.status,
      evidenceRef: item.evidence_ref,
      position: index + 1,
    })),
  };
}

export function resultRelationWrites(
  tx: BatchExecutor,
  input: AiNativeResultInput,
  finalizationToken: string | null,
) {
  const related = relationRows(input);
  const guard = resultWriteGuard(tx, input.result_id, finalizationToken);
  const canInsert = () =>
    and(
      eq(aiNativeResults.id, input.result_id),
      finalizationToken === null
        ? isNull(aiNativeResults.finalizationToken)
        : eq(aiNativeResults.finalizationToken, finalizationToken),
    );

  return [
    tx
      .delete(aiNativeSources)
      .where(and(eq(aiNativeSources.resultId, input.result_id), guard)),
    tx
      .delete(aiNativeSearchSources)
      .where(and(eq(aiNativeSearchSources.resultId, input.result_id), guard)),
    tx
      .delete(aiNativeSearchEvidence)
      .where(and(eq(aiNativeSearchEvidence.resultId, input.result_id), guard)),
    ...related.sources.map((row) =>
      tx.insert(aiNativeSources).select(
        tx
          .select({
            id: sql<string>`${row.id}`.as("id"),
            resultId: sql<string>`${row.resultId}`.as("resultId"),
            value: sql<string>`${row.value}`.as("value"),
            position: sql<number>`${row.position}`.as("position"),
          })
          .from(aiNativeResults)
          .where(canInsert()),
      ),
    ),
    ...related.searchSources.map((row) =>
      tx.insert(aiNativeSearchSources).select(
        tx
          .select({
            id: sql<string>`${row.id}`.as("id"),
            resultId: sql<string>`${row.resultId}`.as("resultId"),
            value: sql<string>`${row.value}`.as("value"),
            position: sql<number>`${row.position}`.as("position"),
          })
          .from(aiNativeResults)
          .where(canInsert()),
      ),
    ),
    ...related.evidence.map((row) =>
      tx.insert(aiNativeSearchEvidence).select(
        tx
          .select({
            id: sql<string>`${row.id}`.as("id"),
            resultId: sql<string>`${row.resultId}`.as("resultId"),
            tool: sql<string>`${row.tool}`.as("tool"),
            status: sql<string>`${row.status}`.as("status"),
            evidenceRef: sql<string>`${row.evidenceRef}`.as("evidenceRef"),
            position: sql<number>`${row.position}`.as("position"),
          })
          .from(aiNativeResults)
          .where(canInsert()),
      ),
    ),
  ];
}

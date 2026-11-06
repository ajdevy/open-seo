import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { chunk } from "remeda";
import { db } from "@/db";
import { runBatch } from "@/db/runBatch";
import {
  aiNativeResults,
  aiNativeSearchEvidence,
  aiNativeSearchSources,
  aiNativeSources,
  aiPrompts,
  aiRuns,
  projects,
} from "@/db/schema";
import type { AiNativeResult } from "@/shared/ai-visibility";
import type { AiNativeResultInput } from "@/types/schemas/ai-native-results";

type NativeResultRow = typeof aiNativeResults.$inferSelect;

function hasSameIdentity(row: NativeResultRow, input: AiNativeResultInput) {
  return (
    row.schemaVersion === input.schema_version &&
    row.clientId === input.client_id &&
    row.projectId === input.project_id &&
    row.runId === input.run_id &&
    row.questionId === input.question_id &&
    row.questionVersion === input.question_version &&
    row.questionSnapshot === input.question &&
    row.requestedModel === input.requested_model &&
    row.route === input.route
  );
}

async function validateRunQuestion(input: AiNativeResultInput) {
  const scope =
    (
      await db
        .select({
          clientId: projects.organizationId,
          question: aiPrompts.text,
        })
        .from(aiRuns)
        .innerJoin(projects, eq(projects.id, aiRuns.projectId))
        .innerJoin(
          aiPrompts,
          and(
            eq(aiPrompts.id, input.question_id),
            eq(aiPrompts.trackerId, aiRuns.trackerId),
          ),
        )
        .where(
          and(
            eq(aiRuns.id, input.run_id),
            eq(aiRuns.projectId, input.project_id),
            eq(projects.organizationId, input.client_id),
          ),
        )
        .limit(1)
    )[0] ?? null;

  if (!scope)
    throw new Error(
      "Native result identity does not match an existing client, project, run, and question.",
    );
  if (scope.question !== input.question)
    throw new Error(
      "Native result question text does not match its saved version.",
    );
}

function resultRow(input: AiNativeResultInput) {
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

async function persistResult(input: AiNativeResultInput) {
  await validateRunQuestion(input);

  const [byId, byModelRoute] = await Promise.all([
    db
      .select()
      .from(aiNativeResults)
      .where(eq(aiNativeResults.id, input.result_id))
      .limit(1)
      .then((rows) => rows[0] ?? null),
    db
      .select({ id: aiNativeResults.id })
      .from(aiNativeResults)
      .where(
        and(
          eq(aiNativeResults.runId, input.run_id),
          eq(aiNativeResults.questionId, input.question_id),
          eq(aiNativeResults.questionVersion, input.question_version),
          eq(aiNativeResults.requestedModel, input.requested_model),
          eq(aiNativeResults.route, input.route),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null),
  ]);

  if (byId && !hasSameIdentity(byId, input))
    throw new Error("Native result id is already bound to another result.");
  if (byModelRoute && byModelRoute.id !== input.result_id)
    throw new Error(
      "A result for this run, question version, model, and route already exists.",
    );

  const sources = input.sources.map((value, index) => ({
    id: crypto.randomUUID(),
    resultId: input.result_id,
    value,
    position: index + 1,
  }));
  const searchSources = input.search_sources.map((value, index) => ({
    id: crypto.randomUUID(),
    resultId: input.result_id,
    value,
    position: index + 1,
  }));
  const evidence = input.search_evidence.map((item, index) => ({
    id: crypto.randomUUID(),
    resultId: input.result_id,
    tool: item.tool,
    status: item.status,
    evidenceRef: item.evidence_ref,
    position: index + 1,
  }));
  const values = resultRow(input);

  await runBatch((tx) => [
    tx
      .insert(aiNativeResults)
      .values(values)
      .onConflictDoUpdate({
        target: [
          aiNativeResults.runId,
          aiNativeResults.questionId,
          aiNativeResults.questionVersion,
          aiNativeResults.requestedModel,
          aiNativeResults.route,
        ],
        set: {
          observedModel: values.observedModel,
          resultStatus: values.resultStatus,
          answer: values.answer,
          searchStatus: values.searchStatus,
          collectedAt: values.collectedAt,
          eligibleForVisibility: values.eligibleForVisibility,
          errorCode: values.errorCode,
          turnStatus: values.turnStatus,
        },
        setWhere: eq(aiNativeResults.id, input.result_id),
      }),
    tx
      .delete(aiNativeSources)
      .where(eq(aiNativeSources.resultId, input.result_id)),
    tx
      .delete(aiNativeSearchSources)
      .where(eq(aiNativeSearchSources.resultId, input.result_id)),
    tx
      .delete(aiNativeSearchEvidence)
      .where(eq(aiNativeSearchEvidence.resultId, input.result_id)),
    ...chunk(sources, 20).map((rows) =>
      tx.insert(aiNativeSources).values(rows),
    ),
    ...chunk(searchSources, 20).map((rows) =>
      tx.insert(aiNativeSearchSources).values(rows),
    ),
    ...chunk(evidence, 12).map((rows) =>
      tx.insert(aiNativeSearchEvidence).values(rows),
    ),
  ]);

  const stored =
    (
      await db
        .select({ id: aiNativeResults.id })
        .from(aiNativeResults)
        .where(
          and(
            eq(aiNativeResults.runId, input.run_id),
            eq(aiNativeResults.questionId, input.question_id),
            eq(aiNativeResults.questionVersion, input.question_version),
            eq(aiNativeResults.requestedModel, input.requested_model),
            eq(aiNativeResults.route, input.route),
          ),
        )
        .limit(1)
    )[0] ?? null;
  if (!stored || stored.id !== input.result_id)
    throw new Error(
      "A result for this run, question version, model, and route already exists.",
    );
}

async function listByRuns(
  projectId: string,
  runIds: string[],
  promptId?: string,
  topic?: string,
): Promise<AiNativeResult[]> {
  if (!runIds.length) return [];

  const rows = await db
    .select({ result: aiNativeResults })
    .from(aiNativeResults)
    .innerJoin(aiRuns, eq(aiRuns.id, aiNativeResults.runId))
    .innerJoin(projects, eq(projects.id, aiRuns.projectId))
    .innerJoin(aiPrompts, eq(aiPrompts.id, aiNativeResults.questionId))
    .where(
      and(
        eq(aiRuns.projectId, projectId),
        eq(aiNativeResults.projectId, projectId),
        inArray(aiNativeResults.runId, runIds),
        promptId ? eq(aiNativeResults.questionId, promptId) : undefined,
        topic ? eq(aiPrompts.topic, topic) : undefined,
      ),
    )
    .orderBy(
      desc(aiNativeResults.collectedAt),
      asc(aiNativeResults.requestedModel),
      asc(aiNativeResults.route),
      asc(aiNativeResults.id),
    );

  const sources = new Map<string, string[]>();
  const searchSources = new Map<string, string[]>();
  const evidence = new Map<string, AiNativeResult["searchEvidence"]>();
  for (let offset = 0; offset < rows.length; offset += 80) {
    const ids = rows.slice(offset, offset + 80).map(({ result }) => result.id);
    const [sourceRows, searchSourceRows, evidenceRows] = await Promise.all([
      db
        .select()
        .from(aiNativeSources)
        .where(inArray(aiNativeSources.resultId, ids))
        .orderBy(asc(aiNativeSources.position)),
      db
        .select()
        .from(aiNativeSearchSources)
        .where(inArray(aiNativeSearchSources.resultId, ids))
        .orderBy(asc(aiNativeSearchSources.position)),
      db
        .select()
        .from(aiNativeSearchEvidence)
        .where(inArray(aiNativeSearchEvidence.resultId, ids))
        .orderBy(
          asc(aiNativeSearchEvidence.resultId),
          asc(aiNativeSearchEvidence.position),
        ),
    ]);

    for (const row of sourceRows)
      sources.set(row.resultId, [
        ...(sources.get(row.resultId) ?? []),
        row.value,
      ]);
    for (const row of searchSourceRows)
      searchSources.set(row.resultId, [
        ...(searchSources.get(row.resultId) ?? []),
        row.value,
      ]);
    for (const row of evidenceRows)
      evidence.set(row.resultId, [
        ...(evidence.get(row.resultId) ?? []),
        {
          tool: row.tool,
          status: row.status,
          evidenceRef: row.evidenceRef,
        },
      ]);
  }

  return rows.map(({ result }) => ({
    id: result.id,
    schemaVersion: result.schemaVersion,
    clientId: result.clientId,
    projectId: result.projectId,
    runId: result.runId,
    questionId: result.questionId,
    questionVersion: result.questionVersion,
    question: result.questionSnapshot,
    requestedModel: result.requestedModel,
    observedModel: result.observedModel,
    route: result.route,
    resultStatus: result.resultStatus,
    answer: result.answer,
    searchStatus: result.searchStatus,
    searchEvidence: evidence.get(result.id) ?? [],
    searchSources: searchSources.get(result.id) ?? [],
    sources: sources.get(result.id) ?? [],
    eligibleForVisibility: result.eligibleForVisibility,
    errorCode: result.errorCode,
    turnStatus: result.turnStatus,
    collectedAt: result.collectedAt,
  }));
}

export const AiNativeResultRepository = { persistResult, listByRuns };

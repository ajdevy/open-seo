import type { BillingCustomerContext } from "@/server/billing/subscription";
import type { AiRun } from "@/shared/ai-visibility";
import {
  createAiNativeRunSchema,
  recordAiNativeResultSchema,
  type AiNativeResultInput,
} from "@/types/schemas/ai-native-results";
import { AiNativeResultRepository as nativeRepo } from "../repositories/AiNativeResultRepository";
import { AiVisibilityRepository as repo } from "../repositories/AiVisibilityRepository";
import { aiScope } from "./aiVisibilityConfiguration";
import { AiVisibilityError } from "./aiVisibilityErrors";
import { requireConfiguration } from "./aiVisibilityMutation";
import { getRun } from "./aiVisibilityRuns";

const MAX_NATIVE_TASKS = 90;

export async function createAiNativeRun(
  rawInput: unknown,
  billing: BillingCustomerContext,
) {
  const input = createAiNativeRunSchema.parse(rawInput);
  if (new Set(input.questionIds).size !== input.questionIds.length)
    throw new AiVisibilityError(
      "INVALID_PROMPT_SELECTION",
      "Choose each question only once.",
    );
  const targetKeys = input.targets.map(
    ({ requestedModel, route }) => `${requestedModel}\0${route}`,
  );
  if (new Set(targetKeys).size !== targetKeys.length)
    throw new AiVisibilityError(
      "INVALID_NATIVE_TARGETS",
      "Choose each model and route combination only once.",
    );
  if (input.questionIds.length * input.targets.length > MAX_NATIVE_TASKS)
    throw new AiVisibilityError(
      "NATIVE_RUN_TOO_LARGE",
      `A synthetic run can contain up to ${MAX_NATIVE_TASKS} question and model/route tasks.`,
    );

  const config = await requireConfiguration(input.projectId);
  const project = await repo.getProject(input.projectId);
  if (
    !project?.domain ||
    project.archivedAt ||
    project.organizationId !== billing.organizationId
  )
    throw new AiVisibilityError(
      "PROJECT_NOT_FOUND",
      "The selected project is not available for this run.",
    );
  const scope = aiScope(config, input.questionIds);
  if (!scope.prompts.length)
    throw new AiVisibilityError(
      "NO_ACTIVE_PROMPTS",
      "Add or unpause prompts before creating a synthetic run.",
    );

  const now = new Date().toISOString();
  const runId = crypto.randomUUID();
  const run = {
    id: runId,
    trackerId: config.tracker.id,
    projectId: project.id,
    trigger: "manual" as const,
    status: "running" as const,
    locationCode: config.tracker.locationCode,
    languageCode: config.tracker.languageCode,
    createdAt: now,
    completedAt: null,
  };
  const tasks = scope.prompts.flatMap((prompt) =>
    input.targets.map((target) => ({
      id: crypto.randomUUID(),
      schemaVersion: 1,
      clientId: project.organizationId,
      projectId: project.id,
      runId,
      questionId: prompt.id,
      questionVersion: 1,
      questionSnapshot: prompt.text,
      requestedModel: target.requestedModel,
      observedModel: null,
      route: target.route,
      resultStatus: "pending",
      answer: null,
      searchStatus: "pending",
      eligibleForVisibility: null,
      errorCode: null,
      turnStatus: null,
      collectedAt: now,
    })),
  );

  try {
    await nativeRepo.createSyntheticRun(run, tasks);
  } catch (error) {
    const blocker = await repo.getActiveRun(config.tracker.id);
    if (!blocker) throw error;
    throw new AiVisibilityError(
      "RUN_IN_PROGRESS",
      "A check is already collecting answers. Read that run instead; this synthetic run was not created.",
      blocker.id,
    );
  }

  const runView = await getRun({ projectId: project.id, runId });
  return {
    run: runView,
    tasks: tasks.map((task) => ({
      resultId: task.id,
      questionId: task.questionId,
      question: task.questionSnapshot,
      requestedModel: task.requestedModel,
      route: task.route,
      status: task.resultStatus,
    })),
  };
}

function matchesRecordedResult(
  stored: Awaited<ReturnType<typeof nativeRepo.listByRuns>>[number],
  input: ReturnType<typeof recordAiNativeResultSchema.parse>,
) {
  return (
    stored.resultStatus === input.resultStatus &&
    stored.observedModel === (input.observedModel ?? null) &&
    stored.answer === input.answer &&
    stored.searchStatus === input.searchStatus &&
    JSON.stringify(stored.searchEvidence) ===
      JSON.stringify(input.searchEvidence) &&
    JSON.stringify(stored.searchSources) ===
      JSON.stringify(input.searchSources) &&
    JSON.stringify(stored.sources) === JSON.stringify(input.sources) &&
    stored.eligibleForVisibility === input.eligibleForVisibility &&
    stored.errorCode === (input.errorCode ?? null) &&
    stored.turnStatus === (input.turnStatus ?? null)
  );
}

export async function recordAiNativeRunResult(
  rawInput: unknown,
  billing: BillingCustomerContext,
): Promise<{
  runId: string;
  resultId: string;
  resultStatus: "completed" | "failed";
  run: AiRun;
}> {
  const input = recordAiNativeResultSchema.parse(rawInput);
  const project = await repo.getProject(input.projectId);
  if (
    !project ||
    project.archivedAt ||
    project.organizationId !== billing.organizationId
  )
    throw new AiVisibilityError(
      "RUN_NOT_FOUND",
      "This run is not available in the selected project.",
    );
  const task = await nativeRepo.getSyntheticTask({
    projectId: input.projectId,
    runId: input.runId,
    resultId: input.resultId,
    organizationId: billing.organizationId,
  });
  if (!task)
    throw new AiVisibilityError(
      "RUN_NOT_FOUND",
      "This task is not available in the selected project and run.",
    );

  if (task.result.resultStatus !== "pending") {
    const stored = (
      await nativeRepo.listByRuns(input.projectId, [input.runId])
    ).find((result) => result.id === input.resultId);
    if (stored && matchesRecordedResult(stored, input))
      return {
        runId: input.runId,
        resultId: input.resultId,
        resultStatus: input.resultStatus,
        run: await getRun({ projectId: input.projectId, runId: input.runId }),
      };
    throw new AiVisibilityError(
      "NATIVE_RESULT_ALREADY_RECORDED",
      "This task already has a different final result and cannot be overwritten.",
      input.runId,
    );
  }
  if (task.runStatus !== "running" && task.runStatus !== "queued")
    throw new AiVisibilityError(
      "RUN_NOT_ACTIVE",
      "This run is no longer accepting results.",
      input.runId,
    );

  const result: AiNativeResultInput = {
    schema_version: task.result.schemaVersion,
    client_id: task.result.clientId,
    project_id: task.result.projectId,
    run_id: task.result.runId,
    question_id: task.result.questionId,
    question_version: task.result.questionVersion,
    result_id: task.result.id,
    timestamp: new Date().toISOString(),
    question: task.question,
    requested_model: task.result.requestedModel,
    observed_model: input.observedModel ?? null,
    route: task.result.route,
    result_status: input.resultStatus,
    answer: input.answer,
    search_status: input.searchStatus,
    search_evidence: input.searchEvidence.map((item) => ({
      tool: item.tool,
      status: item.status,
      evidence_ref: item.evidenceRef,
    })),
    search_sources: input.searchSources,
    sources: input.sources,
    eligible_for_visibility: input.eligibleForVisibility,
    error_code: input.errorCode ?? null,
    turn_status: input.turnStatus ?? null,
  };
  const persisted = await nativeRepo.persistSyntheticResult(result);
  if (!persisted) {
    const stored = (
      await nativeRepo.listByRuns(input.projectId, [input.runId])
    ).find((candidate) => candidate.id === input.resultId);
    if (stored && matchesRecordedResult(stored, input))
      return {
        runId: input.runId,
        resultId: input.resultId,
        resultStatus: input.resultStatus,
        run: await getRun({ projectId: input.projectId, runId: input.runId }),
      };
    throw new AiVisibilityError(
      "NATIVE_RESULT_ALREADY_RECORDED",
      "This task already has a different final result and cannot be overwritten.",
      input.runId,
    );
  }
  const run = await getRun({ projectId: input.projectId, runId: input.runId });
  return {
    runId: input.runId,
    resultId: input.resultId,
    resultStatus: input.resultStatus,
    run,
  };
}

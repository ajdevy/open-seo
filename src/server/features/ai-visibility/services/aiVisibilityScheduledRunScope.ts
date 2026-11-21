import { AiVisibilityRepository as repo } from "../repositories/AiVisibilityRepository";
import type { RunRow } from "../repositories/AiVisibilityRepository";
import { activeAiPrompts, trackerEngines } from "./aiVisibilityConfiguration";

type ValidationStage = "queue" | "dispatch";

export async function scheduledRunScopeError(
  run: RunRow,
  stage: ValidationStage,
) {
  if (!(await repo.isProjectActive(run.projectId)))
    return stage === "dispatch"
      ? "The scheduled check was canceled because its project was archived before provider dispatch."
      : "The scheduled check was canceled because its project was archived before the queued check started.";

  const config = await repo.getConfiguration(run.projectId);
  if (!config || !config.tracker.enabled)
    return stage === "dispatch"
      ? "Scheduled tracking was paused before provider dispatch."
      : "Scheduled tracking was paused before the queued check started.";

  const prompts = activeAiPrompts(config);
  const engines = trackerEngines(config.tracker);
  if (!prompts.length || !engines.length)
    return stage === "dispatch"
      ? "The saved scheduled tracking scope is no longer available."
      : "The saved tracking scope no longer has active prompts and models.";
  if (
    config.tracker.locationCode !== run.locationCode ||
    config.tracker.languageCode !== run.languageCode
  )
    return stage === "dispatch"
      ? "The saved market changed before provider dispatch."
      : "The saved market changed before the queued check started.";

  const expected = new Set(
    prompts.flatMap((prompt) =>
      engines.map((engine) => `${prompt.id}:${engine}`),
    ),
  );
  const observations = await repo.getObservations([run.id]);
  const actual = new Set(
    observations.map(
      (observation) => `${observation.promptId}:${observation.engine}`,
    ),
  );
  if (
    actual.size !== expected.size ||
    [...expected].some((observation) => !actual.has(observation))
  )
    return stage === "dispatch"
      ? "The saved prompt or model scope changed before scheduled provider dispatch."
      : "The saved prompt or model scope changed before the queued check started.";
  return null;
}

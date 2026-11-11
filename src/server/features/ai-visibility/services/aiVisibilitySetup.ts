import { AiVisibilityRepository as repo } from "../repositories/AiVisibilityRepository";
import { writeConfiguration } from "../repositories/aiVisibilityConfigurationRepository";
import type { SaveAiTrackerInput } from "@/types/schemas/ai-visibility";
import { projectPatch } from "./aiVisibilityMutation";
import { getTracker } from "./aiVisibilityState";
import {
  commitProjectSettingsMutation,
  makeProjectSettingsSnapshot,
  readProjectSettingsRows,
} from "@/server/features/project-settings-snapshots/snapshotRepository";

/** Creates or edits tracking. A new tracker starts weekly, first check a week out. */
export async function saveTracker(input: SaveAiTrackerInput) {
  const { projectId, ...patch } = input;
  const { created, updated, skipped } = await commitProjectSettingsMutation(
    projectId,
    async () => {
      const current = await repo.getConfiguration(projectId);
      const { rows, created, updated, skipped } = await projectPatch(
        projectId,
        patch,
        current,
      );
      const state = await readProjectSettingsRows(projectId);
      if (!state) throw new Error("The selected project is not available.");
      return {
        snapshot: makeProjectSettingsSnapshot({
          ...state,
          tracker: rows.tracker,
          questions: rows.prompts,
        }),
        write: (tx) => writeConfiguration(tx, rows),
        result: { created, updated, skipped },
      };
    },
  );
  return { state: await getTracker({ projectId }), created, updated, skipped };
}

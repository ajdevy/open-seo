import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createSyntheticRun } from "./syntheticRun";
import { SyntheticRunControls } from "./SyntheticRunControls";
import type { NativeRunTarget } from "./syntheticRun";
import type { AiTrackerState } from "@/shared/ai-visibility";
import { AiQueryError, aiVisibilityKey } from "./shared";

export function SyntheticRunPanel({
  projectId,
  state,
  runId,
  onSelectRunId,
}: {
  projectId: string;
  state: AiTrackerState;
  runId: string | undefined;
  onSelectRunId: (runId: string | undefined) => void;
}) {
  const queryClient = useQueryClient();
  const activePrompts = state.prompts.filter(
    (prompt) => !prompt.archived && !prompt.paused,
  );
  const createNativeRun = useMutation({
    mutationFn: (targets: NativeRunTarget[]) =>
      createSyntheticRun(
        projectId,
        activePrompts.map((prompt) => prompt.id),
        targets,
      ),
    onSuccess: ({ run }) => {
      queryClient.setQueryData<AiTrackerState>(
        [...aiVisibilityKey(projectId), "tracker"],
        (previous) =>
          previous
            ? {
                ...previous,
                recentRuns: [
                  run,
                  ...previous.recentRuns.filter((item) => item.id !== run.id),
                ].slice(0, 10),
              }
            : previous,
      );
      onSelectRunId(run.id);
    },
  });

  return (
    <>
      <SyntheticRunControls
        prompts={activePrompts}
        recentRuns={state.recentRuns}
        runId={runId}
        creating={createNativeRun.isPending}
        onSelectRunId={onSelectRunId}
        onCreate={(targets) => createNativeRun.mutate(targets)}
      />
      {createNativeRun.error && <AiQueryError error={createNativeRun.error} />}
    </>
  );
}

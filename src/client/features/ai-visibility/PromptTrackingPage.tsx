import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageSquare, Plus } from "lucide-react";
import { toast } from "sonner";
import { EmptyState } from "@/client/components/EmptyState";
import { SkeletonPageContent } from "@/client/components/SkeletonPresets";
import { PageHeader } from "@/client/components/PageHeader";
import { Button } from "@/client/components/ui/button";
import { projectsQueryOptions } from "@/client/features/projects/projectQueries";
import {
  saveAiVisibilityTracker,
  setAiVisibilitySchedule,
} from "@/serverFunctions/ai-visibility";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import {
  type AiPrompt,
  type AiRun,
  type AiTrackerState,
} from "@/shared/ai-visibility";
import type { AiTrackerPatch } from "@/types/schemas/ai-visibility";
import type { PromptTrackingTab } from "./PromptTrackingTabs";
import { ConfiguredTrackingPanel } from "./ConfiguredTrackingPanel";
import { TrackerEditor, TrackerEditorMode } from "./TrackerEditor";
import { prefetchRunNowCost, TrackingCostReview } from "./TrackingCostReview";
import { TrackingScheduleSummary } from "./TrackingScheduleSummary";
import { PromptEditor, TrackerPatchReview } from "./TrackerPatchReview";
import {
  AiQueryError,
  aiVisibilityKey,
  useAiRunProgress,
  useAiVisibilityTracker,
} from "./shared";
import type { ProjectMarket } from "@/client/features/projects/types";
import { DEFAULT_LOCATION_CODE } from "@/shared/keyword-locations";

export function PromptTrackingPage({
  projectId,
  tab,
  runId,
  onSelectRunId,
}: {
  projectId: string;
  tab: PromptTrackingTab;
  runId: string | undefined;
  onSelectRunId: (runId: string | undefined) => void;
}) {
  const query = useAiVisibilityTracker(projectId);
  const projects = useQuery(projectsQueryOptions());
  const project = projects.data?.find((item) => item.id === projectId);
  if (query.isPending) return <SkeletonPageContent />;
  if (query.isError)
    return (
      <AiQueryError
        error={query.error}
        retry={() => {
          void query.refetch();
        }}
      />
    );
  // Brand details always come from the shared project.
  if (projects.isPending) return <SkeletonPageContent />;
  if (projects.isError)
    return (
      <AiQueryError
        error={projects.error}
        retry={() => {
          void projects.refetch();
        }}
      />
    );
  return (
    <PromptTrackingContent
      projectId={projectId}
      tab={tab}
      runId={runId}
      onSelectRunId={onSelectRunId}
      state={query.data}
      defaultMarket={{
        locationCode: project?.locationCode ?? DEFAULT_LOCATION_CODE,
        languageCode: project?.languageCode ?? "en",
      }}
    />
  );
}

function PromptTrackingContent({
  projectId,
  tab,
  runId,
  onSelectRunId,
  state,
  defaultMarket,
}: {
  projectId: string;
  tab: PromptTrackingTab;
  runId: string | undefined;
  onSelectRunId: (runId: string | undefined) => void;
  state: AiTrackerState;
  defaultMarket: ProjectMarket;
}) {
  const queryClient = useQueryClient();
  const [editorMode, setEditorMode] = useState<TrackerEditorMode | null>(null);
  const [managingTracking, setManagingTracking] = useState(false);
  const [costMode, setCostMode] = useState<"check" | "schedule" | null>(null);
  const [editingPrompt, setEditingPrompt] = useState<AiPrompt | null>(null);
  const [change, setChange] = useState<AiTrackerPatch | null>(null);
  const initialRun = runId
    ? (state.recentRuns.find((run) => run.id === runId) ?? null)
    : (state.recentRuns[0] ?? null);
  const progress = useAiRunProgress(projectId, initialRun, runId);
  const currentRun = progress.run ?? (runId ? null : initialRun);
  const tracker = state.tracker;
  const activePrompts = state.prompts.filter(
    (prompt) => !prompt.archived && !prompt.paused,
  );
  const saved = (next: AiTrackerState, run?: AiRun, closeEditor = true) => {
    queryClient.setQueryData([...aiVisibilityKey(projectId), "tracker"], next);
    void queryClient.invalidateQueries({
      queryKey: aiVisibilityKey(projectId),
    });
    if (closeEditor) setEditorMode(null);
    setEditingPrompt(null);
    setChange(null);
    if (run) onSelectRunId(run.id);
    toast.success(run ? "Run started" : "Prompt tracking saved");
  };
  const pauseSchedule = useMutation({
    mutationFn: () =>
      setAiVisibilitySchedule({
        data: { projectId, enabled: false },
      }),
    onSuccess: (result) => {
      saved(result.state);
      setManagingTracking(false);
      toast.success("Tracking paused");
    },
    onError: (error) => toast.error(getStandardErrorMessage(error)),
  });
  const reduceTracking = useMutation({
    mutationFn: (patch: AiTrackerPatch) =>
      saveAiVisibilityTracker({ data: { projectId, ...patch } }),
    onSuccess: (result) => saved(result.state),
    onError: (error) => toast.error(getStandardErrorMessage(error)),
  });
  const busy =
    progress.run?.status === "running" || progress.run?.status === "queued";
  // Price Run now on load and again when the active prompts or engines
  // change, so the dialog opens on the current price.
  const engines = state.engines.join();
  useEffect(() => {
    if (tracker && !runId) prefetchRunNowCost(queryClient, projectId, tracker);
  }, [queryClient, projectId, tracker, runId, activePrompts.length, engines]);
  const schedule = tracker && (
    <TrackingScheduleSummary
      tracker={tracker}
      canSchedule={
        state.providerConfigured &&
        !busy &&
        (tracker.enabled || activePrompts.length > 0)
      }
      pausePending={pauseSchedule.isPending}
      onPause={() => pauseSchedule.mutate()}
      onSchedule={() => {
        setEditorMode(null);
        setManagingTracking(false);
        setCostMode("schedule");
      }}
    />
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title="Prompt Tracking"
        description="Track the prompts your customers use with AI. Inspect where your business is mentioned or cited."
      />
      {!state.configured ? (
        <EmptyState
          variant="card"
          icon={MessageSquare}
          title="Start with the prompts that matter to your business"
          description="Add a topic and its prompts using your saved project settings."
          action={
            <Button onClick={() => setEditorMode(TrackerEditorMode.Prompts)}>
              <Plus />
              Add prompts
            </Button>
          }
        />
      ) : (
        <ConfiguredTrackingPanel
          projectId={projectId}
          state={state}
          tab={tab}
          runId={runId}
          currentRun={currentRun}
          loadingSelectedRun={Boolean(runId && progress.isPending)}
          progressError={progress.error ?? null}
          reducePending={reduceTracking.isPending}
          onSelectRunId={onSelectRunId}
          onEditSettings={() => setEditorMode(TrackerEditorMode.Settings)}
          onRunNow={() => setCostMode("check")}
          onSetup={() => setEditorMode(TrackerEditorMode.Prompts)}
          onEditPrompt={setEditingPrompt}
          onReduce={(patch) => reduceTracking.mutate(patch)}
          onReview={setChange}
        />
      )}
      {editorMode && (
        <TrackerEditor
          projectId={projectId}
          state={state}
          defaultMarket={defaultMarket}
          mode={editorMode}
          open={!managingTracking}
          schedule={schedule}
          onManageTracking={() => setManagingTracking(true)}
          onClose={() => setEditorMode(null)}
          onSaved={saved}
        />
      )}
      {managingTracking && (
        <TrackerEditor
          projectId={projectId}
          state={state}
          defaultMarket={defaultMarket}
          mode={TrackerEditorMode.Settings}
          schedule={schedule}
          onClose={() => setManagingTracking(false)}
          onSaved={(next, run) => {
            saved(next, run, false);
            setManagingTracking(false);
          }}
        />
      )}
      {costMode && tracker && (
        <TrackingCostReview
          projectId={projectId}
          tracker={tracker}
          mode={costMode}
          onClose={() => setCostMode(null)}
          onStarted={(run) => {
            setCostMode(null);
            if (run) onSelectRunId(run.id);
            void queryClient.invalidateQueries({
              queryKey: aiVisibilityKey(projectId),
            });
            toast.success(
              run
                ? "Run started"
                : tracker.enabled
                  ? "Tracking schedule saved"
                  : "Tracking scheduled",
            );
          }}
        />
      )}
      {editingPrompt && (
        <PromptEditor
          prompt={editingPrompt}
          state={state}
          pending={reduceTracking.isPending}
          onClose={() => setEditingPrompt(null)}
          onReview={(patch) => {
            setEditingPrompt(null);
            setChange(patch);
          }}
          onMove={(patch) => reduceTracking.mutate(patch)}
        />
      )}
      {change && (
        <TrackerPatchReview
          projectId={projectId}
          state={state}
          patch={change}
          onClose={() => setChange(null)}
          onSaved={saved}
        />
      )}
    </div>
  );
}

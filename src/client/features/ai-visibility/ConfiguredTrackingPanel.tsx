import { Play, Settings2 } from "lucide-react";
import { Badge } from "@/client/components/ui/badge";
import { Button } from "@/client/components/ui/button";
import type { AiPrompt, AiRun, AiTrackerState } from "@/shared/ai-visibility";
import type { AiTrackerPatch } from "@/types/schemas/ai-visibility";
import { CitationsTab } from "./CitationsTab";
import { CompetitorsTab } from "./CompetitorsTab";
import { PromptList } from "./PromptList";
import {
  PromptTrackingTabs,
  type PromptTrackingTab,
} from "./PromptTrackingTabs";
import { SyntheticRunPanel } from "./SyntheticRunPanel";
import { RunStatusLine } from "./RunStatusLine";
import { VisibilityTrend } from "./VisibilityTrend";
import { AiQueryError, AiRunStatus } from "./shared";
import { InsufficientCreditsError } from "@/client/features/billing/InsufficientCreditsError";
import { scheduleLabel } from "@/shared/rank-tracking";

export function ConfiguredTrackingPanel({
  projectId,
  state,
  tab,
  runId,
  currentRun,
  loadingSelectedRun,
  progressError,
  reducePending,
  onSelectRunId,
  onEditSettings,
  onRunNow,
  onSetup,
  onEditPrompt,
  onReduce,
  onReview,
}: {
  projectId: string;
  state: AiTrackerState;
  tab: PromptTrackingTab;
  runId: string | undefined;
  currentRun: AiRun | null;
  loadingSelectedRun: boolean;
  progressError: Error | null;
  reducePending: boolean;
  onSelectRunId: (runId: string | undefined) => void;
  onEditSettings: () => void;
  onRunNow: () => void;
  onSetup: () => void;
  onEditPrompt: (prompt: AiPrompt) => void;
  onReduce: (patch: AiTrackerPatch) => void;
  onReview: (patch: AiTrackerPatch) => void;
}) {
  const tracker = state.tracker;
  const ownBrand = state.brands.find((brand) => brand.own);
  const activePrompts = state.prompts.filter(
    (prompt) => !prompt.archived && !prompt.paused,
  );
  const busy =
    currentRun?.status === "running" || currentRun?.status === "queued";

  return (
    <>
      {progressError && <AiQueryError error={progressError} />}
      <SyntheticRunPanel
        projectId={projectId}
        state={state}
        runId={runId}
        onSelectRunId={onSelectRunId}
      />
      {loadingSelectedRun && !currentRun && (
        <p className="text-sm text-muted-foreground" role="status">
          Loading selected run…
        </p>
      )}
      <div className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        <div className="space-y-3 px-4 pt-4 pb-3">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-lg font-semibold">{ownBrand?.name}</h2>
                <Badge variant={tracker?.enabled ? "success" : "secondary"}>
                  {tracker?.enabled
                    ? `${scheduleLabel(tracker.scheduleInterval)} tracking`
                    : "Paused"}
                </Badge>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" onClick={onEditSettings}>
                <Settings2 />
                Tracking settings
              </Button>
              {!runId && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={
                    !state.providerConfigured ||
                    activePrompts.length === 0 ||
                    busy
                  }
                  onClick={onRunNow}
                >
                  <Play />
                  Run now
                </Button>
              )}
            </div>
          </div>
          {currentRun ? (
            <AiRunStatus run={currentRun} />
          ) : (
            <RunStatusLine run={null} tracker={tracker} />
          )}
          {tracker?.lastSkipReason === "INSUFFICIENT_CREDITS" ? (
            <InsufficientCreditsError variant="inline" />
          ) : (
            tracker?.lastSkipReason && (
              <p className="text-xs text-warning">
                Most recent scheduling notice: {tracker.lastSkipReason}
              </p>
            )
          )}
        </div>
        <VisibilityTrend projectId={projectId} collecting={busy} />
        <PromptTrackingTabs projectId={projectId} tab={tab} runId={runId} />
        {tab === "prompts" && (
          <PromptList
            key={currentRun?.id ?? "new"}
            projectId={projectId}
            state={state}
            currentRun={currentRun}
            collecting={busy}
            onSetup={onSetup}
            onEdit={onEditPrompt}
            onReduce={onReduce}
            onReview={onReview}
            reducePending={reducePending}
          />
        )}
        {tab === "competitors" && (
          <CompetitorsTab
            projectId={projectId}
            state={state}
            runId={currentRun?.id}
            collecting={busy}
          />
        )}
        {tab === "citations" && (
          <CitationsTab
            key={currentRun?.id ?? "new"}
            projectId={projectId}
            state={state}
            runId={currentRun?.id}
            collecting={busy}
          />
        )}
      </div>
    </>
  );
}

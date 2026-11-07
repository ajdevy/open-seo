import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { PromptTrackingPage } from "@/client/features/ai-visibility/PromptTrackingPage";
import { PROMPT_TRACKING_TABS } from "@/client/features/ai-visibility/PromptTrackingTabs";
import {
  aiRunResultsQueryOptions,
  aiTrackerQueryOptions,
  aiTrendQueryOptions,
} from "@/client/features/ai-visibility/shared";
import { queryClient } from "@/client/tanstack-db/queryClient";

const tabs = PROMPT_TRACKING_TABS.map((item) => item.value);

export const Route = createFileRoute("/_app/p/$projectId/ai-visibility/")({
  validateSearch: z.object({
    tab: z.enum(tabs).optional().catch(undefined),
    run_id: z.string().uuid().optional().catch(undefined),
  }),
  loaderDeps: ({ search }) => ({ runId: search.run_id }),
  loader: ({ params: { projectId }, deps }) => {
    void queryClient.prefetchQuery(aiTrendQueryOptions(projectId, 7));
    // Keep a selected run's result preload on the same project-scoped run ID.
    void queryClient
      .fetchQuery({ ...aiTrackerQueryOptions(projectId), staleTime: 0 })
      .then((state) => {
        const runId = deps.runId ?? state.recentRuns[0]?.id;
        if (runId)
          return queryClient.prefetchQuery(
            aiRunResultsQueryOptions(projectId, runId),
          );
      })
      .catch(() => undefined);
  },
  component: PromptTrackingRoute,
});

function PromptTrackingRoute() {
  const { projectId } = Route.useParams();
  const { tab, run_id: runId } = Route.useSearch();
  const navigate = useNavigate();
  return (
    <PromptTrackingPage
      key={projectId}
      projectId={projectId}
      tab={tab ?? "prompts"}
      runId={runId}
      onSelectRunId={(nextRunId) =>
        void navigate({
          to: "/p/$projectId/ai-visibility",
          params: { projectId },
          replace: true,
          search: { tab, run_id: nextRunId },
        })
      }
    />
  );
}

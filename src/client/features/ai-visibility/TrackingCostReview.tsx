import { useState } from "react";
import {
  keepPreviousData,
  queryOptions,
  useMutation,
  useQuery,
  type QueryClient,
} from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { FormDialog } from "@/client/components/FormDialog";
import { Button } from "@/client/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldLabel,
} from "@/client/components/ui/field";
import {
  estimateAiVisibilityCost,
  runAiVisibilityCheck,
  setAiVisibilitySchedule,
} from "@/serverFunctions/ai-visibility";
import type {
  AiRun,
  AiScheduleInterval,
  AiTracker,
} from "@/shared/ai-visibility";
import { ScheduleField } from "@/client/features/rank-tracking/ScheduleField";
import {
  localScheduleTimeFrom,
  randomScheduleDate,
  withBrowserTimeZone,
  type LocalScheduleTime,
} from "@/client/features/rank-tracking/scheduleTime";
import { DEFAULT_AI_WEEKLY_SCHEDULE } from "@/shared/ai-visibility-schedule";
import { AiLoading, AiQueryError, aiMoney, aiVisibilityKey } from "./shared";

const costEstimateQueryOptions = ({
  projectId,
  mode,
  scheduleInterval,
  promptIds,
}: {
  projectId: string;
  mode: "check" | "schedule";
  scheduleInterval: AiScheduleInterval;
  promptIds?: string[];
}) =>
  queryOptions({
    queryKey: [
      ...aiVisibilityKey(projectId),
      "estimate",
      mode,
      scheduleInterval,
      promptIds,
    ],
    queryFn: () =>
      estimateAiVisibilityCost({
        data: {
          projectId,
          promptIds,
          scheduleInterval: mode === "schedule" ? scheduleInterval : undefined,
        },
      }),
    // Price the tracker as it is now each time the dialog opens, showing the
    // price the page preloaded while that runs.
    staleTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });

/** Starts pricing a run before Run now is clicked, so the dialog opens on a price. */
export function prefetchRunNowCost(
  queryClient: QueryClient,
  projectId: string,
  tracker: AiTracker,
  promptIds?: string[],
) {
  void queryClient.prefetchQuery(
    costEstimateQueryOptions({
      projectId,
      mode: "check",
      scheduleInterval: tracker.scheduleInterval,
      promptIds,
    }),
  );
}

export function TrackingCostReview({
  projectId,
  tracker,
  mode,
  promptIds,
  onClose,
  onStarted,
}: {
  projectId: string;
  tracker: AiTracker;
  mode: "check" | "schedule";
  promptIds?: string[];
  onClose: () => void;
  onStarted: (run: AiRun | null) => void;
}) {
  const [scheduleInterval, setScheduleInterval] = useState<AiScheduleInterval>(
    tracker.scheduleInterval,
  );
  // Keep a saved IANA timezone, or use the selected default for a new tracker.
  const [scheduleTime, setScheduleTime] = useState<LocalScheduleTime>(() => {
    if (
      tracker.scheduleWeekday !== null &&
      tracker.scheduleHour !== null &&
      tracker.scheduleMinute !== null &&
      tracker.scheduleTimeZone
    )
      return {
        weekday: tracker.scheduleWeekday,
        hour: tracker.scheduleHour,
        minute: tracker.scheduleMinute,
        timeZone: tracker.scheduleTimeZone,
      };
    if (tracker.enabled && tracker.nextCheckAt)
      return localScheduleTimeFrom(new Date(tracker.nextCheckAt));
    return tracker.scheduleInterval === "weekly"
      ? DEFAULT_AI_WEEKLY_SCHEDULE
      : localScheduleTimeFrom(randomScheduleDate());
  });
  const savedWallClockSchedule =
    tracker.scheduleWeekday !== null &&
    tracker.scheduleHour !== null &&
    tracker.scheduleMinute !== null &&
    tracker.scheduleTimeZone !== null
      ? {
          weekday: tracker.scheduleWeekday,
          hour: tracker.scheduleHour,
          minute: tracker.scheduleMinute,
          timeZone: tracker.scheduleTimeZone,
        }
      : null;
  const [scheduleTimeEdited, setScheduleTimeEdited] = useState(false);
  const estimate = useQuery({
    ...costEstimateQueryOptions({
      projectId,
      mode,
      scheduleInterval,
      promptIds,
    }),
    placeholderData: keepPreviousData,
  });
  const cost = estimate.data;
  // Run now collects live answers; scheduled runs use the cheaper queue.
  const runCostUsd =
    (mode === "check" ? cost?.runNowCostUsd : cost?.costUsd) ?? 0;
  const start = useMutation({
    mutationFn: async () => {
      if (!cost) throw new Error("Review the estimate before starting.");
      if (mode === "schedule") {
        const result = await setAiVisibilitySchedule({
          data: {
            projectId,
            enabled: true,
            scheduleInterval,
            // An unchanged schedule keeps its next check.
            scheduleTime:
              !tracker.enabled ||
              scheduleTimeEdited ||
              scheduleInterval !== tracker.scheduleInterval
                ? withBrowserTimeZone(scheduleTime)
                : undefined,
          },
        });
        return result.run;
      }
      return runAiVisibilityCheck({
        data: {
          projectId,
          maxCostUsd: cost.runNowCostUsd,
          promptIds,
        },
      });
    },
    onSuccess: onStarted,
  });

  return (
    <FormDialog
      title={
        mode === "check"
          ? "Run now"
          : tracker.enabled
            ? "Change tracking schedule"
            : "Schedule tracking"
      }
      onClose={() => {
        if (!start.isPending) onClose();
      }}
      actions={
        <>
          <Button variant="ghost" disabled={start.isPending} onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={
              !cost ||
              // Approve only the current price, not the preloaded one
              // still being refreshed.
              estimate.isFetching ||
              start.isPending ||
              cost.observations === 0
            }
            onClick={() => start.mutate()}
          >
            {start.isPending && <Loader2 className="size-4 animate-spin" />}
            {mode === "check"
              ? "Run now"
              : tracker.enabled
                ? "Save schedule"
                : "Start tracking"}
          </Button>
        </>
      }
    >
      {estimate.isPending ? (
        <AiLoading />
      ) : estimate.isError ? (
        <AiQueryError
          error={estimate.error}
          retry={() => {
            void estimate.refetch();
          }}
        />
      ) : (
        cost && (
          <>
            {mode === "schedule" && (
              <ScheduleField
                allowManual={false}
                schedule={scheduleInterval}
                onScheduleChange={(value) => {
                  if (value === "manual") return;
                  if (value === "weekly" && scheduleInterval !== "weekly") {
                    setScheduleTime(
                      savedWallClockSchedule ?? DEFAULT_AI_WEEKLY_SCHEDULE,
                    );
                  } else if (
                    value !== "weekly" &&
                    scheduleInterval === "weekly" &&
                    scheduleTime.timeZone
                  ) {
                    setScheduleTime({
                      weekday: scheduleTime.weekday,
                      hour: scheduleTime.hour,
                      minute: scheduleTime.minute,
                    });
                  }
                  setScheduleInterval(value);
                }}
                scheduleTime={scheduleTime}
                onScheduleTimeChange={(time) => {
                  setScheduleTime(time);
                  setScheduleTimeEdited(true);
                }}
                showTimeZone
              />
            )}
            <Field>
              <FieldLabel>
                {mode === "schedule" ? "Cost per run" : "Cost"}
              </FieldLabel>
              <span className="text-2xl font-semibold tabular-nums">
                {aiMoney(runCostUsd)}
              </span>
              <FieldDescription>
                {/* No per-answer price: engines cost different amounts. */}
                {`${cost.observations} ${cost.observations === 1 ? "answer" : "answers"}${mode === "schedule" ? ` · about ${aiMoney(cost.monthlyCostUsd)} a month (${cost.checksPerMonth} ${cost.checksPerMonth === 1 ? "run" : "runs"})` : " · live answers, ready in a few minutes"}`}
              </FieldDescription>
            </Field>
            {start.error && <AiQueryError error={start.error} />}
          </>
        )
      )}
    </FormDialog>
  );
}

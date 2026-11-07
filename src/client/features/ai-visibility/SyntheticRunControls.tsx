import { useState, type FormEvent } from "react";
import { Button } from "@/client/components/ui/button";
import { Input } from "@/client/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/client/components/ui/select";
import type { AiPrompt, AiRun } from "@/shared/ai-visibility";
import { aiDate } from "./shared";
import type { NativeRunTarget } from "./syntheticRun";

export function SyntheticRunControls({
  prompts,
  recentRuns,
  runId,
  creating,
  onSelectRunId,
  onCreate,
}: {
  prompts: AiPrompt[];
  recentRuns: AiRun[];
  runId: string | undefined;
  creating: boolean;
  onSelectRunId: (runId: string | undefined) => void;
  onCreate: (targets: NativeRunTarget[]) => void;
}) {
  const [targets, setTargets] = useState<NativeRunTarget[]>([
    { requestedModel: "", route: "" },
  ]);
  const selectedValue = runId ?? "latest";
  const hasRun = recentRuns.some((run) => run.id === runId);
  const runOptions = runId && !hasRun ? [{ id: runId }] : [];
  const targetKeys = targets.map(
    ({ requestedModel, route }) => `${requestedModel.trim()}\0${route.trim()}`,
  );
  const taskCount = prompts.length * targets.length;
  const canCreate =
    prompts.length > 0 &&
    targets.length > 0 &&
    taskCount <= 90 &&
    targets.every(
      ({ requestedModel, route }) =>
        requestedModel.trim().length > 0 && route.trim().length > 0,
    ) &&
    new Set(targetKeys).size === targetKeys.length;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canCreate || creating) return;
    onCreate(
      targets.map(({ requestedModel, route }) => ({
        requestedModel: requestedModel.trim(),
        route: route.trim(),
      })),
    );
  };

  return (
    <section
      aria-label="Synthetic run controls"
      className="space-y-4 rounded-lg border border-border bg-card p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-sm font-medium">Synthetic run</h2>
          <p className="text-xs text-muted-foreground">
            Select a project run or create server-owned tasks for active
            prompts. Creating tasks does not call a model or provider.
          </p>
        </div>
        <Select
          value={selectedValue}
          onValueChange={(value) => {
            if (value === "latest") onSelectRunId(undefined);
            else if (value) onSelectRunId(value);
          }}
        >
          <SelectTrigger aria-label="Select AI visibility run" className="w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="latest">Latest project run</SelectItem>
            {runOptions.map((option) => (
              <SelectItem key={option.id} value={option.id}>
                Run {option.id}
              </SelectItem>
            ))}
            {recentRuns.map((run) => (
              <SelectItem key={run.id} value={run.id}>
                {aiDate(run.createdAt)} · {run.status} · {run.completed}/
                {run.expected}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <form className="space-y-3 border-t border-border pt-3" onSubmit={submit}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-medium">Create a synthetic run</h3>
            <p className="text-xs text-muted-foreground">
              Creates {taskCount} pending task{taskCount === 1 ? "" : "s"} for{" "}
              {prompts.length} active prompt{prompts.length === 1 ? "" : "s"}.
              Results can be recorded later against these task IDs.
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={
              creating ||
              targets.length >= 90 ||
              taskCount + prompts.length > 90
            }
            onClick={() =>
              setTargets((value) => [
                ...value,
                { requestedModel: "", route: "" },
              ])
            }
          >
            Add model
          </Button>
        </div>
        <div className="space-y-2">
          {targets.map((target, index) => (
            <div key={index} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
              <Input
                aria-label={`Requested model ${index + 1}`}
                placeholder="Requested model"
                value={target.requestedModel}
                onChange={(event) =>
                  setTargets((value) =>
                    value.map((item, itemIndex) =>
                      itemIndex === index
                        ? { ...item, requestedModel: event.target.value }
                        : item,
                    ),
                  )
                }
              />
              <Input
                aria-label={`Route ${index + 1}`}
                placeholder="Route"
                value={target.route}
                onChange={(event) =>
                  setTargets((value) =>
                    value.map((item, itemIndex) =>
                      itemIndex === index
                        ? { ...item, route: event.target.value }
                        : item,
                    ),
                  )
                }
              />
              {targets.length > 1 && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label={`Remove model ${index + 1}`}
                  disabled={creating}
                  onClick={() =>
                    setTargets((value) =>
                      value.filter((_, itemIndex) => itemIndex !== index),
                    )
                  }
                >
                  Remove
                </Button>
              )}
            </div>
          ))}
        </div>
        <Button type="submit" size="sm" disabled={!canCreate || creating}>
          {creating ? "Creating run…" : "Create synthetic run"}
        </Button>
        {prompts.length === 0 && (
          <p className="text-xs text-muted-foreground">
            Add or unpause a prompt before creating a run.
          </p>
        )}
        {taskCount > 90 && (
          <p role="alert" className="text-xs text-destructive">
            A run can contain at most 90 prompt and model tasks.
          </p>
        )}
      </form>
    </section>
  );
}

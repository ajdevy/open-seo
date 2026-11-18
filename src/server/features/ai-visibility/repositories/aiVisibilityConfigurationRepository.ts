import { and, asc, eq, exists, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { runBatch } from "@/db/runBatch";
import { normalizeAiSuggestion } from "@/shared/ai-prompt-suggestions";
import {
  aiTrackers,
  aiPrompts,
  aiRuns,
  aiObservations,
  projects,
} from "@/db/schema";
import {
  commitProjectSettingsMutation,
  makeProjectSettingsSnapshot,
  readProjectSettingsRows,
} from "@/server/features/project-settings-snapshots/snapshotRepository";
import { AiVisibilityError } from "../services/aiVisibilityErrors";

export type TrackerRow = typeof aiTrackers.$inferSelect;
export type PromptRow = typeof aiPrompts.$inferSelect;
export type RunRow = typeof aiRuns.$inferSelect;
export type ObservationRow = typeof aiObservations.$inferSelect;
type Tx = Parameters<Parameters<typeof runBatch>[0]>[0];
export interface ConfigurationRows {
  tracker: TrackerRow;
  prompts: PromptRow[];
}

const SCHEDULED_RUN_SCOPE_CHANGED_REASON =
  "The scheduled check was canceled because tracking was paused or its " +
  "saved scope changed before provider dispatch.";
const SCHEDULED_RUN_CONFIGURATION_CHANGED_REASON =
  "The scheduled check was canceled because tracking settings changed before provider dispatch.";
const SCHEDULED_RUN_SCOPE_FIELDS = [
  "chatgpt",
  "gemini",
  "googleAiOverview",
  "claude",
  "perplexity",
  "locationCode",
  "languageCode",
] as const;

/**
 * Prevents a queued scheduled run from being dispatched after tracking is
 * paused or its scope is removed. Keep the writes in the caller's transaction.
 */
export function cancelQueuedScheduledRuns(
  tx: Tx,
  trackerId: string,
  reason = SCHEDULED_RUN_SCOPE_CHANGED_REASON,
  runId?: string,
) {
  const queuedRuns = tx
    .select({ id: aiRuns.id })
    .from(aiRuns)
    .where(
      and(
        eq(aiRuns.trackerId, trackerId),
        eq(aiRuns.trigger, "scheduled"),
        eq(aiRuns.status, "queued"),
        runId ? eq(aiRuns.id, runId) : undefined,
      ),
    );
  const queuedRun = and(
    eq(aiRuns.trackerId, trackerId),
    eq(aiRuns.trigger, "scheduled"),
    eq(aiRuns.status, "queued"),
    runId ? eq(aiRuns.id, runId) : undefined,
  );
  return [
    tx
      .update(aiObservations)
      .set({ status: "failed", error: reason })
      .where(
        and(
          inArray(aiObservations.runId, queuedRuns),
          eq(aiObservations.status, "pending"),
        ),
      ),
    tx
      .update(aiTrackers)
      .set({ pendingScheduledRunId: null, lastSkipReason: reason })
      .where(
        and(
          eq(aiTrackers.id, trackerId),
          inArray(aiTrackers.pendingScheduledRunId, queuedRuns),
        ),
      ),
    tx
      .update(aiTrackers)
      .set({ lastSkipReason: reason })
      .where(and(eq(aiTrackers.id, trackerId), exists(queuedRuns))),
    tx
      .update(aiRuns)
      .set({ status: "failed", completedAt: new Date().toISOString() })
      .where(queuedRun),
  ];
}

export async function getTracker(projectId: string) {
  return (
    (
      await db
        .select()
        .from(aiTrackers)
        .where(eq(aiTrackers.projectId, projectId))
        .limit(1)
    )[0] ?? null
  );
}

export async function getConfiguration(
  projectId: string,
): Promise<ConfigurationRows | null> {
  const tracker = await getTracker(projectId);
  if (!tracker) return null;
  const prompts = await db
    .select()
    .from(aiPrompts)
    .where(eq(aiPrompts.trackerId, tracker.id))
    .orderBy(asc(aiPrompts.createdAt), asc(aiPrompts.id));
  return { tracker, prompts };
}

export async function saveConfiguration(rows: ConfigurationRows) {
  await runBatch((tx) => writeConfiguration(tx, rows));
}

const SNAPSHOTTED_TRACKER_FIELDS = new Set([
  "enabled",
  "chatgpt",
  "gemini",
  "googleAiOverview",
  "claude",
  "perplexity",
  "locationCode",
  "languageCode",
  "scheduleInterval",
]);

/** Updates tracker settings and their snapshot in one project mutation. */
export async function updateTracker(id: string, values: Partial<TrackerRow>) {
  if (!Object.keys(values).some((key) => SNAPSHOTTED_TRACKER_FIELDS.has(key))) {
    await db.update(aiTrackers).set(values).where(eq(aiTrackers.id, id));
    return;
  }

  const [tracker] = await db
    .select({ projectId: aiTrackers.projectId })
    .from(aiTrackers)
    .where(eq(aiTrackers.id, id))
    .limit(1);
  if (!tracker) return;

  await commitProjectSettingsMutation(tracker.projectId, async () => {
    const state = await readProjectSettingsRows(tracker.projectId);
    if (!state?.tracker || state.tracker.id !== id)
      throw new Error("The saved AI tracker is not available.");
    const nextTracker = {
      ...state.tracker,
      enabled: values.enabled ?? state.tracker.enabled,
      chatgpt: values.chatgpt ?? state.tracker.chatgpt,
      gemini: values.gemini ?? state.tracker.gemini,
      googleAiOverview:
        values.googleAiOverview ?? state.tracker.googleAiOverview,
      claude: values.claude ?? state.tracker.claude,
      perplexity: values.perplexity ?? state.tracker.perplexity,
      locationCode: values.locationCode ?? state.tracker.locationCode,
      languageCode: values.languageCode ?? state.tracker.languageCode,
      scheduleInterval:
        values.scheduleInterval ?? state.tracker.scheduleInterval,
    };
    if (values.enabled === true) {
      if (!state.questions.some((prompt) => !prompt.paused && !prompt.archived))
        throw new AiVisibilityError(
          "NO_ACTIVE_PROMPTS",
          "Add active prompts before enabling scheduled tracking.",
        );
      if (
        !nextTracker.chatgpt &&
        !nextTracker.gemini &&
        !nextTracker.googleAiOverview &&
        !nextTracker.claude &&
        !nextTracker.perplexity
      )
        throw new AiVisibilityError(
          "NO_ACTIVE_ENGINES",
          "Select at least one AI engine before enabling scheduled tracking.",
        );
    }
    return {
      snapshot: makeProjectSettingsSnapshot({
        ...state,
        tracker: nextTracker,
      }),
      write: (tx) => [
        ...(values.enabled === false ||
        SCHEDULED_RUN_SCOPE_FIELDS.some((key) => values[key] !== undefined)
          ? cancelQueuedScheduledRuns(
              tx,
              id,
              values.lastSkipReason ?? "Scheduled tracking is paused.",
            )
          : []),
        tx.update(aiTrackers).set(values).where(eq(aiTrackers.id, id)),
      ],
      result: undefined,
    };
  });
}

/** Upserts collection settings and pauses trackers whose saved scope is empty. */
export function writeConfiguration(tx: Tx, rows: ConfigurationRows) {
  const { tracker } = rows;
  return [
    tx
      .insert(aiTrackers)
      .values(tracker)
      .onConflictDoUpdate({
        target: aiTrackers.id,
        set: {
          enabled: tracker.enabled,
          chatgpt: tracker.chatgpt,
          gemini: tracker.gemini,
          googleAiOverview: tracker.googleAiOverview,
          claude: tracker.claude,
          perplexity: tracker.perplexity,
          locationCode: tracker.locationCode,
          languageCode: tracker.languageCode,
        },
      }),
    ...rows.prompts.map((prompt) =>
      tx
        .insert(aiPrompts)
        .values(prompt)
        .onConflictDoUpdate({
          target: aiPrompts.id,
          set: {
            topic: prompt.topic,
            paused: prompt.paused,
            archived: prompt.archived,
          },
        }),
    ),
    ...cancelQueuedScheduledRuns(
      tx,
      tracker.id,
      tracker.enabled
        ? SCHEDULED_RUN_CONFIGURATION_CHANGED_REASON
        : SCHEDULED_RUN_SCOPE_CHANGED_REASON,
    ),
  ];
}

/** Fills a project's missing Prompt Research keywords, in the given order. */
export function writeResearchKeywords(
  tx: Tx,
  projectId: string,
  names: string[],
) {
  return [
    tx
      .update(projects)
      .set({ aiResearchKeywords: researchKeywordsValue(names) })
      .where(
        and(eq(projects.id, projectId), isNull(projects.aiResearchKeywords)),
      ),
  ];
}

export function researchKeywordsValue(names: string[]) {
  // One keyword per line, so a keyword itself never holds a line break.
  const keywords = [
    ...new Map(
      names.map((name) => [
        normalizeAiSuggestion(name),
        name.replace(/\s+/g, " ").trim(),
      ]),
    ).values(),
  ].filter(Boolean);
  return keywords.join("\n") || null;
}

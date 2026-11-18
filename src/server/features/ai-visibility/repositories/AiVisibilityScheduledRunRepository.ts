import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { runBatch } from "@/db/runBatch";
import { aiObservations, aiRuns, aiTrackers, projects } from "@/db/schema";
import { cancelQueuedScheduledRuns } from "./aiVisibilityConfigurationRepository";

/**
 * Claims one scheduled occurrence and persists its queued run in the same
 * transaction. The tracker pointer is a durable outbox: a later cron tick can
 * resume the same workflow id if this process stops after the commit.
 */
async function claimScheduledRun(input: {
  trackerId: string;
  observedNextCheckAt: string;
  nextCheckAt: string;
  lastSkipReason: string | null;
  run: typeof aiRuns.$inferInsert;
  observations: (typeof aiObservations.$inferInsert)[];
}) {
  const { run } = input;
  await runBatch((tx) => [
    tx
      .update(aiTrackers)
      .set({
        nextCheckAt: input.nextCheckAt,
        lastSkipReason: input.lastSkipReason,
        pendingScheduledRunId: run.id,
      })
      .where(
        and(
          eq(aiTrackers.id, input.trackerId),
          eq(aiTrackers.enabled, true),
          eq(aiTrackers.nextCheckAt, input.observedNextCheckAt),
          isNull(aiTrackers.pendingScheduledRunId),
        ),
      ),
    tx.insert(aiRuns).select(
      tx
        .select({
          id: sql<string>`${run.id}`.as("id"),
          trackerId: aiTrackers.id,
          projectId: aiTrackers.projectId,
          trigger: sql<typeof run.trigger>`${run.trigger}`.as("trigger"),
          status: sql<typeof run.status>`'queued'`.as("status"),
          locationCode: sql<number>`${run.locationCode}`.as("locationCode"),
          languageCode: sql<string>`${run.languageCode}`.as("languageCode"),
          createdAt: sql<string>`${run.createdAt}`.as("createdAt"),
          completedAt: sql<string | null>`NULL`.as("completedAt"),
        })
        .from(aiTrackers)
        .where(
          and(
            eq(aiTrackers.id, input.trackerId),
            eq(aiTrackers.pendingScheduledRunId, run.id),
          ),
        ),
    ),
    ...input.observations.map((observation) =>
      tx.insert(aiObservations).select(
        tx
          .select({
            id: sql<string>`${observation.id}`.as("id"),
            runId: aiRuns.id,
            promptId: sql<string>`${observation.promptId}`.as("promptId"),
            engine: sql<typeof observation.engine>`${observation.engine}`.as(
              "engine",
            ),
            branded: sql<typeof observation.branded>`${observation.branded}`.as(
              "branded",
            ),
            status: sql<typeof observation.status>`'pending'`.as("status"),
            collectedAt: sql<string | null>`NULL`.as("collectedAt"),
            answerMarkdown: sql<string | null>`NULL`.as("answerMarkdown"),
            error: sql<string | null>`NULL`.as("error"),
          })
          .from(aiRuns)
          .where(eq(aiRuns.id, run.id)),
      ),
    ),
  ]);
  return (
    (await db.select().from(aiRuns).where(eq(aiRuns.id, run.id)).limit(1))[0] ??
    null
  );
}

async function listPendingScheduledRuns() {
  return db
    .select({
      trackerId: aiTrackers.id,
      pendingScheduledRunId: aiTrackers.pendingScheduledRunId,
      organizationId: projects.organizationId,
      lastSkipReason: aiTrackers.lastSkipReason,
      run: aiRuns,
    })
    .from(aiTrackers)
    .leftJoin(
      aiRuns,
      and(
        eq(aiRuns.id, aiTrackers.pendingScheduledRunId),
        eq(aiRuns.trigger, "scheduled"),
      ),
    )
    .innerJoin(projects, eq(projects.id, aiTrackers.projectId))
    .where(isNotNull(aiTrackers.pendingScheduledRunId))
    .orderBy(asc(aiRuns.createdAt), asc(aiTrackers.pendingScheduledRunId))
    .limit(50);
}

async function clearPendingScheduledRun(input: {
  trackerId: string;
  runId: string;
  lastSkipReason?: string | null;
}) {
  await db
    .update(aiTrackers)
    .set({
      pendingScheduledRunId: null,
      ...(input.lastSkipReason === undefined
        ? {}
        : { lastSkipReason: input.lastSkipReason }),
    })
    .where(
      and(
        eq(aiTrackers.id, input.trackerId),
        eq(aiTrackers.pendingScheduledRunId, input.runId),
      ),
    );
}

async function setPendingScheduledRunNotice(input: {
  trackerId: string;
  runId: string;
  lastSkipReason: string;
}) {
  await db
    .update(aiTrackers)
    .set({ lastSkipReason: input.lastSkipReason })
    .where(
      and(
        eq(aiTrackers.id, input.trackerId),
        eq(aiTrackers.pendingScheduledRunId, input.runId),
      ),
    );
}

async function cancelQueuedScheduledRun(input: {
  trackerId: string;
  runId: string;
  reason: string;
}) {
  await runBatch((tx) =>
    cancelQueuedScheduledRuns(tx, input.trackerId, input.reason, input.runId),
  );
}

export const AiVisibilityScheduledRunRepository = {
  claimScheduledRun,
  listPendingScheduledRuns,
  clearPendingScheduledRun,
  setPendingScheduledRunNotice,
  cancelQueuedScheduledRun,
};

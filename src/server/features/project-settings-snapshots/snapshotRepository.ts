import { and, asc, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  aiPrompts,
  aiTrackers,
  projectSettingsSnapshotOutbox,
  projectSettingsSnapshotRevisions,
  projects,
} from "@/db/schema";
import { runBatch } from "@/db/runBatch";
import { AppError } from "@/server/lib/errors";
import { encryptProjectSettingsSnapshot } from "./snapshotCrypto";

type Tx = Parameters<Parameters<typeof runBatch>[0]>[0];
type ProjectRow = typeof projects.$inferSelect;
type TrackerRow = typeof aiTrackers.$inferSelect;
type QuestionRow = typeof aiPrompts.$inferSelect;

export interface ProjectSettingsSnapshot {
  clientId: string;
  projectId: string;
  project: {
    name: string;
    domain: string | null;
    locationCode: number;
    languageCode: string;
    aiResearchKeywords: string | null;
    indexnowKey: string | null;
    archivedAt: string | null;
  };
  tracker: null | {
    id: string;
    enabled: boolean;
    engines: {
      chatgpt: boolean;
      gemini: boolean;
      googleAiOverview: boolean;
      claude: boolean;
      perplexity: boolean;
    };
    locationCode: number;
    languageCode: string;
    scheduleInterval: TrackerRow["scheduleInterval"];
  };
  questions: {
    id: string;
    trackerId: string;
    text: string;
    topic: string;
    paused: boolean;
    archived: boolean;
  }[];
}

export function makeProjectSettingsSnapshot(input: {
  project: ProjectRow;
  tracker: TrackerRow | null;
  questions: QuestionRow[];
}): ProjectSettingsSnapshot {
  const { project, tracker } = input;
  return {
    clientId: project.organizationId,
    projectId: project.id,
    project: {
      name: project.name,
      domain: project.domain,
      locationCode: project.locationCode,
      languageCode: project.languageCode,
      aiResearchKeywords: project.aiResearchKeywords,
      indexnowKey: project.indexnowKey,
      archivedAt: project.archivedAt,
    },
    tracker: tracker
      ? {
          id: tracker.id,
          enabled: tracker.enabled,
          engines: {
            chatgpt: tracker.chatgpt,
            gemini: tracker.gemini,
            googleAiOverview: tracker.googleAiOverview,
            claude: tracker.claude,
            perplexity: tracker.perplexity,
          },
          locationCode: tracker.locationCode,
          languageCode: tracker.languageCode,
          scheduleInterval: tracker.scheduleInterval,
        }
      : null,
    questions: input.questions.map((question) => ({
      id: question.id,
      trackerId: question.trackerId,
      text: question.text,
      topic: question.topic,
      paused: question.paused,
      archived: question.archived,
    })),
  };
}

export async function readProjectSettingsRows(projectId: string) {
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) return null;

  const [tracker] = await db
    .select()
    .from(aiTrackers)
    .where(eq(aiTrackers.projectId, projectId))
    .limit(1);
  const questions = tracker
    ? await db
        .select()
        .from(aiPrompts)
        .where(eq(aiPrompts.trackerId, tracker.id))
        .orderBy(asc(aiPrompts.createdAt), asc(aiPrompts.id))
    : [];
  return { project, tracker: tracker ?? null, questions };
}

export interface PreparedProjectSettingsMutation<T> {
  snapshot: ProjectSettingsSnapshot;
  write: (tx: Tx) => readonly Promise<unknown>[];
  result: T;
}

export interface PreparedProjectSettingsMutations<T> {
  snapshots: {
    projectId: string;
    previousRevision: number;
    snapshot: ProjectSettingsSnapshot;
  }[];
  write: (tx: Tx) => readonly Promise<unknown>[];
  result: T;
}

export function isUniqueViolation(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.message.includes("UNIQUE constraint failed")) return true;
  if ("code" in error && error.code === "23505") return true;
  return isUniqueViolation(error.cause);
}

async function latestRevision(projectId: string): Promise<number> {
  const [row] = await db
    .select({ revision: projectSettingsSnapshotRevisions.revision })
    .from(projectSettingsSnapshotRevisions)
    .where(eq(projectSettingsSnapshotRevisions.projectId, projectId))
    .limit(1);
  return row?.revision ?? 0;
}

async function revisionAlreadyQueued(projectId: string, revision: number) {
  const [row] = await db
    .select({ id: projectSettingsSnapshotOutbox.id })
    .from(projectSettingsSnapshotOutbox)
    .where(
      and(
        eq(projectSettingsSnapshotOutbox.projectId, projectId),
        eq(projectSettingsSnapshotOutbox.revision, revision),
      ),
    )
    .limit(1);
  return !!row;
}

/**
 * Saves the app change and its encrypted outbox row in one atomic batch.
 * Concurrent writes that selected the same revision lose on the outbox's
 * unique (project, revision) key and are prepared again from the saved state.
 */
export async function commitProjectSettingsMutations<T>(
  prepare: (
    getPreviousRevision: (projectId: string) => Promise<number>,
  ) => Promise<PreparedProjectSettingsMutations<T>>,
): Promise<T> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const prepared = await prepare(latestRevision);
    const projectIds = prepared.snapshots.map(({ projectId }) => projectId);
    if (new Set(projectIds).size !== projectIds.length)
      throw new Error(
        "A settings snapshot batch contains a duplicate project.",
      );

    const now = new Date().toISOString();
    const revisions = await Promise.all(
      prepared.snapshots.map(
        async ({ projectId, previousRevision, snapshot }) => {
          if (snapshot.projectId !== projectId)
            throw new Error(
              "Snapshot project ID does not match its outbox row.",
            );
          const revision = previousRevision + 1;
          const encrypted = await encryptProjectSettingsSnapshot(
            { ...snapshot, version: 1, revision },
            projectId,
            revision,
          );
          return { projectId, previousRevision, revision, encrypted };
        },
      ),
    );

    try {
      await runBatch((tx) => [
        ...prepared.write(tx),
        ...revisions.flatMap(
          ({ projectId, previousRevision, revision, encrypted }) => [
            previousRevision === 0
              ? tx
                  .insert(projectSettingsSnapshotRevisions)
                  .values({ projectId, revision, updatedAt: now })
                  .onConflictDoNothing()
              : tx
                  .update(projectSettingsSnapshotRevisions)
                  .set({ revision, updatedAt: now })
                  .where(
                    and(
                      eq(projectSettingsSnapshotRevisions.projectId, projectId),
                      eq(
                        projectSettingsSnapshotRevisions.revision,
                        previousRevision,
                      ),
                    ),
                  ),
            tx.insert(projectSettingsSnapshotOutbox).values({
              id: crypto.randomUUID(),
              projectId,
              revision,
              idempotencyKey: `open-seo:project-settings:${projectId}:${revision}`,
              algorithm: encrypted.algorithm,
              schemaVersion: encrypted.schemaVersion,
              iv: encrypted.iv,
              ciphertext: encrypted.ciphertext,
              status: "unconfirmed",
              createdAt: now,
              confirmedAt: null,
            }),
          ],
        ),
      ]);
      return prepared.result;
    } catch (error) {
      if (isUniqueViolation(error)) {
        const collision = await Promise.all(
          revisions.map(({ projectId, revision }) =>
            revisionAlreadyQueued(projectId, revision),
          ),
        );
        if (collision.some(Boolean)) continue;
      }
      throw error;
    }
  }

  throw new AppError(
    "CONFLICT",
    "Project settings changed during save. Retry the save.",
  );
}

export async function commitProjectSettingsMutation<T>(
  projectId: string,
  prepare: () => Promise<PreparedProjectSettingsMutation<T>>,
): Promise<T> {
  return commitProjectSettingsMutations(async (getPreviousRevision) => {
    const previousRevision = await getPreviousRevision(projectId);
    const prepared = await prepare();
    return {
      snapshots: [{ projectId, previousRevision, snapshot: prepared.snapshot }],
      write: prepared.write,
      result: prepared.result,
    };
  });
}

export type ProjectSettingsSnapshotStatus = {
  revision: number | null;
  status: "unavailable" | "unconfirmed" | "confirmed";
  recoverableAfterServerLoss: boolean;
};

export async function getProjectSettingsSnapshotStatus(
  projectId: string,
): Promise<ProjectSettingsSnapshotStatus> {
  const [row] = await db
    .select({
      revision: projectSettingsSnapshotOutbox.revision,
      status: projectSettingsSnapshotOutbox.status,
    })
    .from(projectSettingsSnapshotOutbox)
    .where(eq(projectSettingsSnapshotOutbox.projectId, projectId))
    .orderBy(desc(projectSettingsSnapshotOutbox.revision))
    .limit(1);
  if (!row)
    return {
      revision: null,
      status: "unavailable",
      recoverableAfterServerLoss: false,
    };
  return {
    revision: row.revision,
    status: row.status,
    recoverableAfterServerLoss: row.status === "confirmed",
  };
}

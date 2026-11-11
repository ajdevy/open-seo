import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { runBatch } from "@/db/runBatch";
import { projectSettingsSnapshotOutbox } from "@/db/schema";

const DELIVERY_BATCH_SIZE = 100;

export interface EncryptedProjectSettingsSnapshot {
  projectId: string;
  revision: number;
  idempotencyKey: string;
  algorithm: string;
  schemaVersion: number;
  iv: string;
  ciphertext: string;
}

/**
 * The port must durably store the encrypted envelope before resolving. It must
 * deduplicate repeated writes by idempotencyKey and resolve a replay for the
 * same envelope after an earlier acknowledgement was lost.
 */
export interface ProjectSettingsSnapshotArchivePort {
  putEncryptedSnapshot(
    snapshot: EncryptedProjectSettingsSnapshot,
  ): Promise<void>;
}

export interface ProjectSettingsSnapshotDeliveryResult {
  attempted: number;
  confirmed: number;
  unconfirmed: number;
}

async function confirmOutboxRow(id: string): Promise<boolean> {
  await runBatch((tx) => [
    tx
      .update(projectSettingsSnapshotOutbox)
      .set({ status: "confirmed", confirmedAt: new Date().toISOString() })
      .where(
        and(
          eq(projectSettingsSnapshotOutbox.id, id),
          eq(projectSettingsSnapshotOutbox.status, "unconfirmed"),
        ),
      ),
  ]);

  const [row] = await db
    .select({ status: projectSettingsSnapshotOutbox.status })
    .from(projectSettingsSnapshotOutbox)
    .where(eq(projectSettingsSnapshotOutbox.id, id))
    .limit(1);
  return row?.status === "confirmed";
}

/**
 * Attempts only the oldest unconfirmed revision for each project. That keeps
 * remote history monotonic and prevents a failed revision from being bypassed.
 * Failures leave the encrypted row untouched for the next invocation.
 */
export async function deliverPendingProjectSettingsSnapshots(
  archive: ProjectSettingsSnapshotArchivePort,
): Promise<ProjectSettingsSnapshotDeliveryResult> {
  const oldestPendingRevision = db
    .select({
      projectId: projectSettingsSnapshotOutbox.projectId,
      oldestRevision:
        sql<number>`min(${projectSettingsSnapshotOutbox.revision})`.as(
          "oldest_revision",
        ),
    })
    .from(projectSettingsSnapshotOutbox)
    .where(eq(projectSettingsSnapshotOutbox.status, "unconfirmed"))
    .groupBy(projectSettingsSnapshotOutbox.projectId)
    .as("oldest_pending_snapshot");
  const pending = await db
    .select({
      id: projectSettingsSnapshotOutbox.id,
      projectId: projectSettingsSnapshotOutbox.projectId,
      revision: projectSettingsSnapshotOutbox.revision,
      idempotencyKey: projectSettingsSnapshotOutbox.idempotencyKey,
      algorithm: projectSettingsSnapshotOutbox.algorithm,
      schemaVersion: projectSettingsSnapshotOutbox.schemaVersion,
      iv: projectSettingsSnapshotOutbox.iv,
      ciphertext: projectSettingsSnapshotOutbox.ciphertext,
    })
    .from(projectSettingsSnapshotOutbox)
    .innerJoin(
      oldestPendingRevision,
      and(
        eq(
          projectSettingsSnapshotOutbox.projectId,
          oldestPendingRevision.projectId,
        ),
        eq(
          projectSettingsSnapshotOutbox.revision,
          oldestPendingRevision.oldestRevision,
        ),
      ),
    )
    .orderBy(
      asc(projectSettingsSnapshotOutbox.createdAt),
      asc(projectSettingsSnapshotOutbox.projectId),
    )
    .limit(DELIVERY_BATCH_SIZE);

  let attempted = 0;
  let confirmed = 0;
  for (const row of pending) {
    attempted++;
    try {
      await archive.putEncryptedSnapshot({
        projectId: row.projectId,
        revision: row.revision,
        idempotencyKey: row.idempotencyKey,
        algorithm: row.algorithm,
        schemaVersion: row.schemaVersion,
        iv: row.iv,
        ciphertext: row.ciphertext,
      });
      if (await confirmOutboxRow(row.id)) confirmed++;
    } catch {
      // Keep the row unconfirmed. The archive may have accepted the write but
      // lost its response; the next invocation replays the same idempotency key.
    }
  }

  return {
    attempted,
    confirmed,
    unconfirmed: attempted - confirmed,
  };
}

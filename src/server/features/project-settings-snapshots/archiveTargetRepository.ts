import { and, eq, exists, isNotNull, isNull, sql } from "drizzle-orm";
import type { runBatch } from "@/db/runBatch";
import {
  googleDriveArchiveConnections,
  projectSettingsSnapshotOutbox,
  projects,
} from "@/db/schema";

type Tx = Parameters<Parameters<typeof runBatch>[0]>[0];

export interface GoogleDriveArchiveTargetBinding {
  connectionId: string;
  organizationId: string;
  googleAccountId: string;
  folderId: string;
}

/**
 * Lock the current organization connection even when the caller's earlier
 * read is stale. OAuth reconnect uses this before its transaction-local
 * pending-snapshot check; reservations and target mutations lock this row too.
 */
export function lockGoogleDriveArchiveConnectionForOrganization(
  tx: Tx,
  organizationId: string,
) {
  return tx
    .update(googleDriveArchiveConnections)
    .set({ updatedAt: sql`${googleDriveArchiveConnections.updatedAt}` })
    .where(eq(googleDriveArchiveConnections.organizationId, organizationId));
}

export type GoogleDriveArchiveConnectionTarget = Omit<
  GoogleDriveArchiveTargetBinding,
  "folderId"
> & { folderId: string | null };

/**
 * Take the same connection-row write lock before reserving an ID or changing
 * the target. D1 runs the lock and following statement in one atomic batch;
 * PostgreSQL runs them in one transaction. Keeping this write as a no-op
 * preserves the target values while serializing both operations.
 */
export function lockGoogleDriveArchiveConnectionTarget(
  tx: Tx,
  target: GoogleDriveArchiveConnectionTarget,
) {
  return tx
    .update(googleDriveArchiveConnections)
    .set({ updatedAt: sql`${googleDriveArchiveConnections.updatedAt}` })
    .where(
      and(
        eq(googleDriveArchiveConnections.id, target.connectionId),
        eq(googleDriveArchiveConnections.organizationId, target.organizationId),
        eq(
          googleDriveArchiveConnections.googleAccountId,
          target.googleAccountId,
        ),
        target.folderId === null
          ? isNull(googleDriveArchiveConnections.folderId)
          : eq(googleDriveArchiveConnections.folderId, target.folderId),
        eq(googleDriveArchiveConnections.status, "connected"),
      ),
    );
}

export function targetBoundPendingSnapshotQuery(
  tx: Tx,
  organizationId: string,
) {
  return tx
    .select({ id: projectSettingsSnapshotOutbox.id })
    .from(projectSettingsSnapshotOutbox)
    .innerJoin(
      projects,
      eq(projectSettingsSnapshotOutbox.projectId, projects.id),
    )
    .where(
      and(
        eq(projects.organizationId, organizationId),
        eq(projectSettingsSnapshotOutbox.status, "unconfirmed"),
        isNotNull(projectSettingsSnapshotOutbox.archiveFileId),
      ),
    );
}

export function archiveTargetForProjectQuery(
  tx: Tx,
  projectId: string,
  target: GoogleDriveArchiveTargetBinding,
) {
  return tx
    .select({ id: googleDriveArchiveConnections.id })
    .from(googleDriveArchiveConnections)
    .innerJoin(
      projects,
      eq(projects.organizationId, googleDriveArchiveConnections.organizationId),
    )
    .where(
      and(
        eq(projects.id, projectId),
        eq(googleDriveArchiveConnections.id, target.connectionId),
        eq(googleDriveArchiveConnections.organizationId, target.organizationId),
        eq(
          googleDriveArchiveConnections.googleAccountId,
          target.googleAccountId,
        ),
        eq(googleDriveArchiveConnections.folderId, target.folderId),
        eq(googleDriveArchiveConnections.status, "connected"),
      ),
    );
}

export function archiveTargetMatchesProject(
  tx: Tx,
  projectId: string,
  target: GoogleDriveArchiveTargetBinding,
) {
  return exists(archiveTargetForProjectQuery(tx, projectId, target));
}

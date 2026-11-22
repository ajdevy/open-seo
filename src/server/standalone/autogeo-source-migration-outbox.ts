import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { runBatch } from "@/db/runBatch";
import {
  autoGeoSourceMigrationOutbox as autoGeoSourceMigrationOutboxTable,
  autoGeoSourceMigrationOutboxChunks as autoGeoSourceMigrationOutboxChunksTable,
} from "@/db/schema";
import {
  archiveTargetMatchesOrganization,
  lockGoogleDriveArchiveConnectionTarget,
} from "@/server/features/project-settings-snapshots/archiveTargetRepository";
import { AUTOGEO_SOURCE_CONTRACT_REVISION } from "./autogeo-source-contract";
import {
  parseAutoGeoOutboxEnvelope,
  serializeAutoGeoOutboxEnvelope,
} from "./autogeo-source-migration-outbox-envelope";
import type {
  AutoGeoSourceMigrationOutboxPort,
  AutoGeoSourceMigrationOutboxRecord,
} from "./autogeo-source-migration";

function sameRecordBinding(
  stored: AutoGeoSourceMigrationOutboxRecord,
  expected: AutoGeoSourceMigrationOutboxRecord,
): boolean {
  return (
    stored.clientRef === expected.clientRef &&
    stored.targetOrganizationId === expected.targetOrganizationId &&
    stored.sourceContractRevision === expected.sourceContractRevision &&
    stored.mappingEvidenceRef === expected.mappingEvidenceRef &&
    stored.idempotencyKey === expected.idempotencyKey &&
    stored.artifactsFingerprint === expected.artifactsFingerprint &&
    stored.envelope.clientRef === expected.envelope.clientRef &&
    stored.envelope.sourceContractRevision ===
      expected.envelope.sourceContractRevision &&
    stored.envelope.idempotencyKey === expected.envelope.idempotencyKey
  );
}

function sameArchiveTarget(
  left: AutoGeoSourceMigrationOutboxRecord["archiveTarget"],
  right: AutoGeoSourceMigrationOutboxRecord["archiveTarget"],
): boolean {
  if (!left || !right) return left === right;
  return (
    left.connectionId === right.connectionId &&
    left.organizationId === right.organizationId &&
    left.googleAccountId === right.googleAccountId &&
    left.folderId === right.folderId
  );
}

async function rowToRecord(
  row: typeof autoGeoSourceMigrationOutboxTable.$inferSelect,
): Promise<AutoGeoSourceMigrationOutboxRecord> {
  const envelope = await parseAutoGeoOutboxEnvelope(
    row.encryptedEnvelope,
    row.encryptedEnvelopeStorageId,
  );
  const targetValues = [
    row.archiveConnectionId,
    row.archiveGoogleAccountId,
    row.archiveFolderId,
  ];
  const targetCount = targetValues.filter(Boolean).length;
  if (targetCount !== 0 && targetCount !== targetValues.length)
    throw new Error("AutoGeo source archive target binding is invalid.");
  if (Boolean(row.archiveFileId) !== (targetCount === targetValues.length))
    throw new Error("AutoGeo source archive file reservation is invalid.");
  if (
    row.sourceContractRevision !== AUTOGEO_SOURCE_CONTRACT_REVISION ||
    envelope.clientRef !== row.clientRef ||
    envelope.sourceContractRevision !== row.sourceContractRevision ||
    envelope.idempotencyKey !== row.idempotencyKey
  )
    throw new Error("Encrypted AutoGeo source outbox binding is invalid.");
  return {
    clientRef: row.clientRef,
    targetOrganizationId: row.targetOrganizationId,
    sourceContractRevision: row.sourceContractRevision,
    mappingEvidenceRef: row.mappingEvidenceRef,
    idempotencyKey: row.idempotencyKey,
    artifactsFingerprint: row.artifactsFingerprint,
    envelope,
    archiveFileId: row.archiveFileId,
    archiveTarget:
      targetCount === targetValues.length
        ? {
            connectionId: row.archiveConnectionId!,
            organizationId: row.targetOrganizationId,
            googleAccountId: row.archiveGoogleAccountId!,
            folderId: row.archiveFolderId!,
          }
        : null,
  };
}

async function findStoredRecord(
  clientRef: string,
  idempotencyKey: string,
): Promise<AutoGeoSourceMigrationOutboxRecord | null> {
  const [row] = await db
    .select()
    .from(autoGeoSourceMigrationOutboxTable)
    .where(
      and(
        eq(autoGeoSourceMigrationOutboxTable.clientRef, clientRef),
        eq(autoGeoSourceMigrationOutboxTable.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1);
  return row ? rowToRecord(row) : null;
}

/**
 * Stores only the authenticated ciphertext envelope. Rows have no expiry or
 * organization cascade; retries always return the original envelope and
 * conflicting content never replaces it.
 */
export const autoGeoSourceMigrationOutbox: AutoGeoSourceMigrationOutboxPort = {
  async putIfAbsent(record) {
    const existing = await findStoredRecord(record.clientRef, record.idempotencyKey);
    if (existing) {
      if (!sameRecordBinding(existing, record))
        throw new Error("Conflicting AutoGeo source migration idempotency key.");
      return existing;
    }

    const storageId = crypto.randomUUID();
    const serialized = await serializeAutoGeoOutboxEnvelope(record);
    try {
      await runBatch((tx) => [
        tx
          .insert(autoGeoSourceMigrationOutboxTable)
          .values({
            id: crypto.randomUUID(),
            clientRef: record.clientRef,
            targetOrganizationId: record.targetOrganizationId,
            sourceContractRevision: record.sourceContractRevision,
            mappingEvidenceRef: record.mappingEvidenceRef,
            idempotencyKey: record.idempotencyKey,
            artifactsFingerprint: record.artifactsFingerprint,
            encryptedEnvelope: serialized.metadata,
            encryptedEnvelopeStorageId: storageId,
          })
          .onConflictDoNothing(),
        ...serialized.chunks.map((chunk) =>
          tx
            .insert(autoGeoSourceMigrationOutboxChunksTable)
            .values({ storageId, ...chunk })
            .onConflictDoNothing(),
        ),
      ]);
    } catch (error) {
      // A concurrent idempotent writer may have won the parent unique key.
      // Its storage ID differs, so the foreign key rolls this whole batch back.
      const concurrent = await findStoredRecord(
        record.clientRef,
        record.idempotencyKey,
      );
      if (!concurrent) throw error;
      if (!sameRecordBinding(concurrent, record))
        throw new Error("Conflicting AutoGeo source migration idempotency key.", {
          cause: error,
        });
      return concurrent;
    }

    const stored = await findStoredRecord(record.clientRef, record.idempotencyKey);
    if (!stored) throw new Error("AutoGeo source outbox record was not saved.");
    if (!sameRecordBinding(stored, record))
      throw new Error("Conflicting AutoGeo source migration idempotency key.");
    return stored;
  },

  async reserveArchiveFileId(record, candidate) {
    if (
      !/^[A-Za-z0-9_-]{1,200}$/u.test(candidate.archiveFileId) ||
      candidate.archiveTarget.organizationId !== record.targetOrganizationId
    )
      throw new Error("AutoGeo source archive target is invalid.");
    await runBatch((tx) => [
      lockGoogleDriveArchiveConnectionTarget(tx, candidate.archiveTarget),
      tx
        .update(autoGeoSourceMigrationOutboxTable)
        .set({
          archiveFileId: candidate.archiveFileId,
          archiveConnectionId: candidate.archiveTarget.connectionId,
          archiveGoogleAccountId: candidate.archiveTarget.googleAccountId,
          archiveFolderId: candidate.archiveTarget.folderId,
        })
        .where(
          and(
            eq(autoGeoSourceMigrationOutboxTable.clientRef, record.clientRef),
            eq(
              autoGeoSourceMigrationOutboxTable.idempotencyKey,
              record.idempotencyKey,
            ),
            eq(
              autoGeoSourceMigrationOutboxTable.targetOrganizationId,
              record.targetOrganizationId,
            ),
            eq(
              autoGeoSourceMigrationOutboxTable.artifactsFingerprint,
              record.artifactsFingerprint,
            ),
            eq(autoGeoSourceMigrationOutboxTable.status, "pending"),
            isNull(autoGeoSourceMigrationOutboxTable.archiveFileId),
            archiveTargetMatchesOrganization(
              tx,
              record.targetOrganizationId,
              candidate.archiveTarget,
            ),
          ),
        ),
    ]);

    const stored = await findStoredRecord(record.clientRef, record.idempotencyKey);
    if (!stored) throw new Error("AutoGeo source outbox record was not saved.");
    if (
      !sameRecordBinding(stored, record) ||
      !stored.archiveFileId ||
      !stored.archiveTarget ||
      !sameArchiveTarget(stored.archiveTarget, candidate.archiveTarget)
    )
      throw new Error("AutoGeo source archive reservation changed.");
    return stored;
  },

  async markArchived(record, fileId) {
    if (
      !/^[A-Za-z0-9_-]{1,200}$/u.test(fileId) ||
      !record.archiveFileId ||
      !record.archiveTarget ||
      record.archiveFileId !== fileId
    )
      return false;
    const binding = and(
      eq(autoGeoSourceMigrationOutboxTable.clientRef, record.clientRef),
      eq(
        autoGeoSourceMigrationOutboxTable.idempotencyKey,
        record.idempotencyKey,
      ),
      eq(
        autoGeoSourceMigrationOutboxTable.targetOrganizationId,
        record.targetOrganizationId,
      ),
      eq(
        autoGeoSourceMigrationOutboxTable.artifactsFingerprint,
        record.artifactsFingerprint,
      ),
      eq(autoGeoSourceMigrationOutboxTable.archiveFileId, fileId),
      eq(
        autoGeoSourceMigrationOutboxTable.archiveConnectionId,
        record.archiveTarget.connectionId,
      ),
      eq(
        autoGeoSourceMigrationOutboxTable.archiveGoogleAccountId,
        record.archiveTarget.googleAccountId,
      ),
      eq(
        autoGeoSourceMigrationOutboxTable.archiveFolderId,
        record.archiveTarget.folderId,
      ),
    );
    await db
      .update(autoGeoSourceMigrationOutboxTable)
      .set({
        status: "archived",
        archiveFileId: fileId,
        archivedAt: new Date().toISOString(),
      })
      .where(
        and(binding, eq(autoGeoSourceMigrationOutboxTable.status, "pending")),
      );
    const [row] = await db
      .select()
      .from(autoGeoSourceMigrationOutboxTable)
      .where(binding)
      .limit(1);
    if (
      !row ||
      row.status !== "archived" ||
      row.archiveFileId !== fileId ||
      row.clientRef !== record.clientRef ||
      row.targetOrganizationId !== record.targetOrganizationId ||
      row.sourceContractRevision !== record.sourceContractRevision ||
      row.mappingEvidenceRef !== record.mappingEvidenceRef ||
      row.idempotencyKey !== record.idempotencyKey ||
      row.artifactsFingerprint !== record.artifactsFingerprint
    )
      return false;
    return (
      row.archiveConnectionId === record.archiveTarget.connectionId &&
      row.archiveGoogleAccountId === record.archiveTarget.googleAccountId &&
      row.archiveFolderId === record.archiveTarget.folderId
    );
  },
};

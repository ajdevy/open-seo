import { afterAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

const { testDb } = await vi.hoisted(async () => {
  const { createAiVisibilityTestDb } =
    await import("@/server/features/ai-visibility/aiVisibilityTestDb");
  return { testDb: await createAiVisibilityTestDb() };
});

vi.mock("cloudflare:workers", () => ({
  env: { DATABASE_PROVIDER: "d1" },
  waitUntil: vi.fn(),
}));
vi.mock("@/db", () => ({ db: testDb.db }));
vi.mock("@/db/runBatch", () => ({
  DB_BATCH_SIZE: 100,
  runBatch: testDb.runBatch,
}));

import { autoGeoSourceMigrationOutbox as databaseOutbox } from "./autogeo-source-migration-outbox";
import type { AutoGeoSourceMigrationOutboxRecord } from "./autogeo-source-migration";
import {
  AUTOGEO_SOURCE_ARCHIVE_ALGORITHM,
  AUTOGEO_SOURCE_ARCHIVE_SCHEMA_VERSION,
  fingerprintAutoGeoSourceArtifacts,
  parseEncryptedAutoGeoSourceArchive,
  prepareEncryptedAutoGeoSourceArchive,
} from "./autogeo-source-archive";
import {
  autoGeoSourceMigrationOutbox as outboxTable,
  autoGeoSourceMigrationOutboxChunks as outboxChunksTable,
  googleDriveArchiveConnections,
  organization,
  user,
} from "@/db/schema";
import { hasTargetBoundPendingSourceMigrations } from "@/server/features/project-settings-snapshots/archiveTargetRepository";
import { syntheticSourceArtifacts } from "./autogeo-source-migration.test-fixtures";
import { AUTOGEO_SOURCE_CONTRACT_REVISION } from "./autogeo-source-contract";

describe("AutoGeo migration ciphertext outbox", () => {
  afterAll(() => testDb.client.close());

  it("persists only ciphertext, reuses the original envelope and records archive confirmation", async () => {
    const clientRef = `synthetic-client-${crypto.randomUUID()}`;
    const idempotencyKey = `synthetic-${crypto.randomUUID()}`;
    const targetOrganizationId = `target-${crypto.randomUUID()}`;
    const connectionId = `connection-${crypto.randomUUID()}`;
    const userId = `archive-user-${crypto.randomUUID()}`;
    const archiveTarget = {
      connectionId,
      organizationId: targetOrganizationId,
      googleAccountId: `google-${connectionId}`,
      folderId: `folder-${connectionId}`,
    };
    await testDb.db.insert(organization).values({
      id: targetOrganizationId,
      name: "Synthetic archive target",
      slug: targetOrganizationId,
      createdAt: new Date("2026-11-22T00:00:00.000Z"),
    });
    await testDb.db.insert(user).values({
      id: userId,
      name: "Synthetic archive user",
      email: `${userId}@example.test`,
    });
    await testDb.db.insert(googleDriveArchiveConnections).values({
      id: connectionId,
      organizationId: targetOrganizationId,
      connectedByUserId: userId,
      googleAccountId: archiveTarget.googleAccountId,
      accessTokenCiphertext: "synthetic-encrypted-access-token",
      refreshTokenCiphertext: "synthetic-encrypted-refresh-token",
      accessTokenExpiresAt: "2099-01-01T00:00:00.000Z",
      scope: "drive.file",
      folderId: archiveTarget.folderId,
      folderName: "Synthetic selected folder",
      status: "connected",
      createdAt: "2026-11-22T00:00:00.000Z",
      updatedAt: "2026-11-22T00:00:00.000Z",
    });
    const artifacts = syntheticSourceArtifacts();
    const archiveKey = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    const envelopeInput = {
      clientRef,
      sourceContractRevision: AUTOGEO_SOURCE_CONTRACT_REVISION,
      idempotencyKey,
      artifacts,
    };
    const artifactsFingerprint =
      await fingerprintAutoGeoSourceArtifacts(artifacts);
    const firstEnvelope = await prepareEncryptedAutoGeoSourceArchive(
      envelopeInput,
      archiveKey,
    );
    const firstRecord = await databaseOutbox.putIfAbsent({
      clientRef,
      targetOrganizationId,
      sourceContractRevision: AUTOGEO_SOURCE_CONTRACT_REVISION,
      mappingEvidenceRef: "synthetic-review:source-map",
      idempotencyKey,
      artifactsFingerprint,
      envelope: firstEnvelope,
    });
    const retryEnvelope = await prepareEncryptedAutoGeoSourceArchive(
      envelopeInput,
      archiveKey,
    );
    const retryRecord = await databaseOutbox.putIfAbsent({
      ...firstRecord,
      envelope: retryEnvelope,
    });
    const reservedRecord = await databaseOutbox.reserveArchiveFileId(
      retryRecord,
      { archiveFileId: "drive-file-1", archiveTarget },
    );
    const replayedReservation = await databaseOutbox.reserveArchiveFileId(
      retryRecord,
      { archiveFileId: "drive-file-2", archiveTarget },
    );
    const [storedBeforeArchive] = await testDb.db
      .select()
      .from(outboxTable)
      .where(eq(outboxTable.clientRef, clientRef));

    expect(retryRecord.envelope.iv).toEqual(firstEnvelope.iv);
    expect(retryRecord.envelope.ciphertext).toEqual(firstEnvelope.ciphertext);
    expect(storedBeforeArchive?.encryptedEnvelope).not.toContain(
      "Synthetic historical answer",
    );
    expect(storedBeforeArchive?.encryptedEnvelope).not.toContain(
      "What is Example?",
    );
    expect(storedBeforeArchive?.status).toBe("pending");
    expect(reservedRecord.archiveFileId).toBe("drive-file-1");
    expect(replayedReservation.archiveFileId).toBe("drive-file-1");
    expect(replayedReservation.archiveTarget).toEqual(archiveTarget);
    expect(
      await hasTargetBoundPendingSourceMigrations(targetOrganizationId),
    ).toBe(true);
    expect(
      await databaseOutbox.markArchived(reservedRecord, "drive-file-1"),
    ).toBe(true);
    expect(await databaseOutbox.markArchived(firstRecord, "drive-file-1")).toBe(
      false,
    );
    expect(
      await databaseOutbox.markArchived(reservedRecord, "different-file"),
    ).toBe(false);

    const [storedAfterArchive] = await testDb.db
      .select()
      .from(outboxTable)
      .where(eq(outboxTable.clientRef, clientRef));
    expect(storedAfterArchive?.status).toBe("archived");
    expect(storedAfterArchive?.archiveFileId).toBe("drive-file-1");
    expect(
      await hasTargetBoundPendingSourceMigrations(targetOrganizationId),
    ).toBe(false);
  });

  it("rejects a conflicting retry without replacing the original encrypted envelope", async () => {
    const clientRef = `synthetic-conflict-${crypto.randomUUID()}`;
    const idempotencyKey = `synthetic-${crypto.randomUUID()}`;
    const artifacts = syntheticSourceArtifacts();
    const archiveKey = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    const envelope = await prepareEncryptedAutoGeoSourceArchive(
      {
        clientRef,
        sourceContractRevision: AUTOGEO_SOURCE_CONTRACT_REVISION,
        idempotencyKey,
        artifacts,
      },
      archiveKey,
    );
    const record: AutoGeoSourceMigrationOutboxRecord = {
      clientRef,
      targetOrganizationId: `target-${crypto.randomUUID()}`,
      sourceContractRevision: AUTOGEO_SOURCE_CONTRACT_REVISION,
      mappingEvidenceRef: "synthetic-review:source-map",
      idempotencyKey,
      artifactsFingerprint: await fingerprintAutoGeoSourceArtifacts(artifacts),
      envelope,
    };
    const stored = await databaseOutbox.putIfAbsent(record);

    await expect(
      databaseOutbox.putIfAbsent({
        ...record,
        artifactsFingerprint: "a".repeat(64),
      }),
    ).rejects.toThrow("Conflicting AutoGeo source migration idempotency key.");
    const retry = await databaseOutbox.putIfAbsent(record);
    expect(retry.envelope.ciphertext).toEqual(stored.envelope.ciphertext);
  });

  it("stores oversized envelopes in verified D1-safe chunks and keeps retries idempotent", async () => {
    const clientRef = `synthetic-chunks-${crypto.randomUUID()}`;
    const idempotencyKey = `synthetic-${crypto.randomUUID()}`;
    const artifacts = syntheticSourceArtifacts();
    // The outbox only validates the authenticated envelope's structure. Use a
    // deterministic synthetic ciphertext so this storage-limit test does not
    // spend seconds encrypting and hashing a multi-megabyte source payload.
    const firstEnvelope = parseEncryptedAutoGeoSourceArchive({
      algorithm: AUTOGEO_SOURCE_ARCHIVE_ALGORITHM,
      schemaVersion: AUTOGEO_SOURCE_ARCHIVE_SCHEMA_VERSION,
      clientRef,
      sourceContractRevision: AUTOGEO_SOURCE_CONTRACT_REVISION,
      idempotencyKey,
      iv: new Uint8Array(12).fill(3),
      ciphertext: new Uint8Array(1_500_001).fill(7),
    });
    const record: AutoGeoSourceMigrationOutboxRecord = {
      clientRef,
      targetOrganizationId: `target-${crypto.randomUUID()}`,
      sourceContractRevision: AUTOGEO_SOURCE_CONTRACT_REVISION,
      mappingEvidenceRef: "synthetic-review:large-source-map",
      idempotencyKey,
      artifactsFingerprint: await fingerprintAutoGeoSourceArtifacts(artifacts),
      envelope: firstEnvelope,
    };
    const stored = await databaseOutbox.putIfAbsent(record);
    const [storedRow] = await testDb.db
      .select()
      .from(outboxTable)
      .where(eq(outboxTable.clientRef, clientRef));
    if (!storedRow?.encryptedEnvelopeStorageId)
      throw new Error("Expected oversized outbox row to use chunk storage.");
    const chunks = await testDb.db
      .select()
      .from(outboxChunksTable)
      .where(eq(outboxChunksTable.storageId, storedRow.encryptedEnvelopeStorageId));
    const retry = await databaseOutbox.putIfAbsent(record);

    expect(storedRow?.encryptedEnvelope.length).toBeLessThan(2_000_000);
    expect(Math.ceil(firstEnvelope.ciphertext.byteLength / 3) * 4).toBeGreaterThan(
      2_000_000,
    );
    expect(storedRow?.encryptedEnvelopeStorageId).toBeTruthy();
    expect(chunks.length).toBeGreaterThan(1);
    expect(
      chunks.every((chunk) => chunk.ciphertextBase64.length < 1_400_000),
    ).toBe(true);
    expect(stored.envelope.iv).toEqual(firstEnvelope.iv);
    expect(stored.envelope.ciphertext).toEqual(firstEnvelope.ciphertext);
    expect(retry.envelope.iv).toEqual(firstEnvelope.iv);
    expect(retry.envelope.ciphertext).toEqual(firstEnvelope.ciphertext);

    const firstChunk = chunks.find((chunk) => chunk.chunkIndex === 0);
    if (!firstChunk) throw new Error("Expected first ciphertext chunk.");
    await testDb.db
      .update(outboxChunksTable)
      .set({
        ciphertextBase64: `${firstChunk.ciphertextBase64.startsWith("A") ? "B" : "A"}${firstChunk.ciphertextBase64.slice(1)}`,
      })
      .where(
        and(
          eq(outboxChunksTable.storageId, firstChunk.storageId),
          eq(outboxChunksTable.chunkIndex, firstChunk.chunkIndex),
        ),
      );
    await expect(databaseOutbox.putIfAbsent(record)).rejects.toThrow(
      "Encrypted AutoGeo source outbox checksum mismatch.",
    );
  }, 30_000);
});

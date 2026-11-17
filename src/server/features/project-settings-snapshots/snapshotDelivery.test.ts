import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const { testDb } = await vi.hoisted(async () => {
  const { createAiVisibilityTestDb } =
    await import("@/server/features/ai-visibility/aiVisibilityTestDb");
  return { testDb: await createAiVisibilityTestDb() };
});

vi.mock("cloudflare:workers", () => ({ env: { DATABASE_PROVIDER: "d1" } }));
vi.mock("@/db", () => ({ db: testDb.db }));
vi.mock("@/db/runBatch", () => ({ runBatch: testDb.runBatch }));
vi.mock("@/server/lib/runtime-env", () => ({
  getOptionalEnvValue: async () => undefined,
}));

import {
  googleDriveArchiveConnections,
  projectSettingsSnapshotOutbox,
} from "@/db/schema";
import { getProjectSettingsSnapshotStatus } from "./snapshotRepository";
import {
  deliverPendingProjectSettingsSnapshots,
  type EncryptedProjectSettingsSnapshot,
  type GeneratedProjectSettingsSnapshotArchiveId,
  type ProjectSettingsSnapshotArchivePort,
} from "./snapshotDelivery";

const ORIGINAL_TARGET = {
  connectionId: "drive-connection",
  organizationId: "organization",
  googleAccountId: "google-account-1",
  folderId: "folder-original",
};

function generatedFileId(
  fileId: string,
): GeneratedProjectSettingsSnapshotArchiveId {
  return { fileId, target: ORIGINAL_TARGET };
}

async function seedOutbox(revisions: number[]) {
  await testDb.db.insert(projectSettingsSnapshotOutbox).values(
    revisions.map((revision) => ({
      id: `outbox-${revision}`,
      projectId: "project",
      revision,
      idempotencyKey: `open-seo:project-settings:project:${revision}`,
      algorithm: "AES-GCM-256",
      schemaVersion: 1,
      iv: `iv-${revision}`,
      ciphertext: `encrypted-payload-${revision}`,
      status: "unconfirmed" as const,
      createdAt: `2026-11-11T00:00:0${revision}.000Z`,
      confirmedAt: null,
    })),
  );
}

describe("project settings snapshot delivery", () => {
  beforeEach(async () => {
    await testDb.seedProject();
    await testDb.client.execute(
      "INSERT OR IGNORE INTO user (id, name, email) VALUES ('archive-user', 'Archive User', 'archive@example.invalid')",
    );
    await testDb.db.insert(googleDriveArchiveConnections).values({
      id: "drive-connection",
      organizationId: "organization",
      connectedByUserId: "archive-user",
      googleAccountId: "google-account-1",
      accountEmail: "archive@example.invalid",
      accessTokenCiphertext: "access-token-ciphertext",
      refreshTokenCiphertext: "refresh-token-ciphertext",
      accessTokenExpiresAt: "2099-01-01T00:00:00.000Z",
      scope: "drive.file",
      folderId: "folder-original",
      folderName: "Original",
      status: "connected",
      createdAt: "2026-11-11T00:00:00.000Z",
      updatedAt: "2026-11-11T00:00:00.000Z",
    });
  });

  it("keeps snapshots unconfirmed while the archive is offline and retries after recovery", async () => {
    await testDb.db.insert(projectSettingsSnapshotOutbox).values({
      id: "outbox-1",
      projectId: "project",
      revision: 1,
      idempotencyKey: "open-seo:project-settings:project:1",
      algorithm: "AES-GCM-256",
      schemaVersion: 1,
      iv: "iv-1",
      ciphertext: "encrypted-payload-1",
      status: "unconfirmed",
      createdAt: "2026-11-11T00:00:01.000Z",
      confirmedAt: null,
    });

    let online = false;
    const delivered: EncryptedProjectSettingsSnapshot[] = [];
    const deliveredFileIds: string[] = [];
    let generatedFileIds = 0;
    const archive: ProjectSettingsSnapshotArchivePort = {
      generateFileId: async () =>
        generatedFileId(`generated-drive-file-${++generatedFileIds}`),
      putEncryptedSnapshot: async (snapshot, fileId) => {
        if (!online) throw new Error("synthetic archive offline");
        delivered.push(snapshot);
        deliveredFileIds.push(fileId);
      },
    };

    await expect(
      deliverPendingProjectSettingsSnapshots(archive),
    ).resolves.toEqual({ attempted: 1, confirmed: 0, unconfirmed: 1 });
    await expect(getProjectSettingsSnapshotStatus("project")).resolves.toEqual({
      revision: 1,
      status: "unconfirmed",
      recoverableAfterServerLoss: false,
    });

    online = true;
    await expect(
      deliverPendingProjectSettingsSnapshots(archive),
    ).resolves.toEqual({ attempted: 1, confirmed: 1, unconfirmed: 0 });
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      idempotencyKey: "open-seo:project-settings:project:1",
      ciphertext: "encrypted-payload-1",
    });
    expect(delivered[0]).not.toHaveProperty("snapshot");
    expect(generatedFileIds).toBe(1);
    expect(deliveredFileIds).toEqual(["generated-drive-file-1"]);
    await expect(getProjectSettingsSnapshotStatus("project")).resolves.toEqual({
      revision: 1,
      status: "confirmed",
      recoverableAfterServerLoss: true,
    });
  });

  it("replays the same idempotency key when remote acceptance succeeded but its acknowledgement was lost", async () => {
    await seedOutbox([1]);
    const remoteArchive = new Map<string, EncryptedProjectSettingsSnapshot>();
    const calls: Array<{
      snapshot: EncryptedProjectSettingsSnapshot;
      fileId: string;
    }> = [];
    let loseFirstAcknowledgement = true;
    let generatedFileIds = 0;
    const archive: ProjectSettingsSnapshotArchivePort = {
      generateFileId: async () =>
        generatedFileId(`generated-drive-file-${++generatedFileIds}`),
      putEncryptedSnapshot: async (snapshot, fileId) => {
        calls.push({ snapshot, fileId });
        if (!remoteArchive.has(snapshot.idempotencyKey))
          remoteArchive.set(snapshot.idempotencyKey, snapshot);
        if (loseFirstAcknowledgement) {
          loseFirstAcknowledgement = false;
          throw new Error("synthetic acknowledgement lost");
        }
      },
    };

    await expect(
      deliverPendingProjectSettingsSnapshots(archive),
    ).resolves.toEqual({ attempted: 1, confirmed: 0, unconfirmed: 1 });
    expect(remoteArchive).toHaveProperty("size", 1);

    await expect(
      deliverPendingProjectSettingsSnapshots(archive),
    ).resolves.toEqual({ attempted: 1, confirmed: 1, unconfirmed: 0 });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.snapshot.idempotencyKey).toBe(
      calls[1]?.snapshot.idempotencyKey,
    );
    expect(calls[0]?.snapshot.ciphertext).toBe(calls[1]?.snapshot.ciphertext);
    expect(calls[0]?.fileId).toBe(calls[1]?.fileId);
    expect(generatedFileIds).toBe(1);
    expect(remoteArchive).toHaveProperty("size", 1);
  });

  it("does not deliver a later project revision before the oldest unconfirmed revision", async () => {
    await seedOutbox([1, 2]);
    const calls: number[] = [];
    let online = false;
    let nextFileId = 0;
    const archive: ProjectSettingsSnapshotArchivePort = {
      generateFileId: async () =>
        generatedFileId(`generated-drive-file-${++nextFileId}`),
      putEncryptedSnapshot: async ({ revision }) => {
        calls.push(revision);
        if (!online) throw new Error("synthetic archive offline");
      },
    };

    await deliverPendingProjectSettingsSnapshots(archive);
    expect(calls).toEqual([1]);

    online = true;
    await deliverPendingProjectSettingsSnapshots(archive);
    expect(calls).toEqual([1, 1]);
    await deliverPendingProjectSettingsSnapshots(archive);
    expect(calls).toEqual([1, 1, 2]);
  });

  it("reserves one generated Drive file ID across concurrent delivery attempts", async () => {
    await seedOutbox([1]);
    let generated = 0;
    let releaseGeneration: (() => void) | undefined;
    const bothGenerated = new Promise<void>((resolve) => {
      releaseGeneration = resolve;
    });
    const deliveredFileIds: string[] = [];
    const archive: ProjectSettingsSnapshotArchivePort = {
      generateFileId: async () => {
        const candidate = `generated-drive-file-${++generated}`;
        if (generated === 2) releaseGeneration?.();
        await bothGenerated;
        return generatedFileId(candidate);
      },
      putEncryptedSnapshot: async (_snapshot, fileId) => {
        deliveredFileIds.push(fileId);
      },
    };

    const results = await Promise.all([
      deliverPendingProjectSettingsSnapshots(archive),
      deliverPendingProjectSettingsSnapshots(archive),
    ]);

    expect(results).toEqual([
      { attempted: 1, confirmed: 1, unconfirmed: 0 },
      { attempted: 1, confirmed: 1, unconfirmed: 0 },
    ]);
    expect(generated).toBe(2);
    expect(deliveredFileIds).toHaveLength(2);
    expect(new Set(deliveredFileIds).size).toBe(1);
  });

  it("does not reserve or upload a generated ID after the selected target changes", async () => {
    await seedOutbox([1]);
    const uploadedFileIds: string[] = [];
    const archive: ProjectSettingsSnapshotArchivePort = {
      generateFileId: async () => {
        await testDb.db
          .update(googleDriveArchiveConnections)
          .set({ folderId: "folder-reconnected", folderName: "Reconnected" })
          .where(eq(googleDriveArchiveConnections.id, "drive-connection"));
        return generatedFileId("generated-for-original-folder");
      },
      putEncryptedSnapshot: async (_snapshot, fileId) => {
        uploadedFileIds.push(fileId);
      },
    };

    await expect(
      deliverPendingProjectSettingsSnapshots(archive),
    ).resolves.toEqual({ attempted: 1, confirmed: 0, unconfirmed: 1 });

    const [outbox] = await testDb.db
      .select({ archiveFileId: projectSettingsSnapshotOutbox.archiveFileId })
      .from(projectSettingsSnapshotOutbox)
      .where(eq(projectSettingsSnapshotOutbox.id, "outbox-1"))
      .limit(1);
    expect(outbox?.archiveFileId).toBeNull();
    expect(uploadedFileIds).toEqual([]);
  });
});

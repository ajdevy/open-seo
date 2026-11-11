import { beforeEach, describe, expect, it, vi } from "vitest";

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

import { projectSettingsSnapshotOutbox } from "@/db/schema";
import { getProjectSettingsSnapshotStatus } from "./snapshotRepository";
import {
  deliverPendingProjectSettingsSnapshots,
  type EncryptedProjectSettingsSnapshot,
  type ProjectSettingsSnapshotArchivePort,
} from "./snapshotDelivery";

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
    const archive: ProjectSettingsSnapshotArchivePort = {
      putEncryptedSnapshot: async (snapshot) => {
        if (!online) throw new Error("synthetic archive offline");
        delivered.push(snapshot);
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
    await expect(getProjectSettingsSnapshotStatus("project")).resolves.toEqual({
      revision: 1,
      status: "confirmed",
      recoverableAfterServerLoss: true,
    });
  });

  it("replays the same idempotency key when remote acceptance succeeded but its acknowledgement was lost", async () => {
    await seedOutbox([1]);
    const remoteArchive = new Map<string, EncryptedProjectSettingsSnapshot>();
    const calls: EncryptedProjectSettingsSnapshot[] = [];
    let loseFirstAcknowledgement = true;
    const archive: ProjectSettingsSnapshotArchivePort = {
      putEncryptedSnapshot: async (snapshot) => {
        calls.push(snapshot);
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
    expect(calls[0]?.idempotencyKey).toBe(calls[1]?.idempotencyKey);
    expect(calls[0]?.ciphertext).toBe(calls[1]?.ciphertext);
    expect(remoteArchive).toHaveProperty("size", 1);
  });

  it("does not deliver a later project revision before the oldest unconfirmed revision", async () => {
    await seedOutbox([1, 2]);
    const calls: number[] = [];
    let online = false;
    const archive: ProjectSettingsSnapshotArchivePort = {
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
});

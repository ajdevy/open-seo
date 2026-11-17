import { eq } from "drizzle-orm";
import { beforeEach, expect, it, vi } from "vitest";
import { WorkspaceMergeService } from "./workspace-merge";
import type { ProjectSettingsSnapshotArchivePort } from "@/server/features/project-settings-snapshots/snapshotDelivery";
import { deliverPendingProjectSettingsSnapshots } from "../features/project-settings-snapshots/snapshotDelivery";
import {
  googleDriveTokenContext,
  readConfig,
  tokenCipher,
} from "../features/project-settings-snapshots/googleDriveArchiveOAuthShared";
import {
  googleDriveArchiveConnections,
  organization,
  projectSettingsSnapshotOutbox,
  projectSettingsSnapshotRevisions,
  projects,
} from "@/db/schema";

const { testDb } = await vi.hoisted(async () => {
  const { createAiVisibilityTestDb } =
    await import("@/server/features/ai-visibility/aiVisibilityTestDb");
  return { testDb: await createAiVisibilityTestDb() };
});

const mockEnv = vi.hoisted(
  () =>
    ({ DATABASE_PROVIDER: "d1", AUTH_MODE: "cloudflare_access" }) as {
      DATABASE_PROVIDER: string;
      AUTH_MODE: string;
    },
);

vi.mock("cloudflare:workers", () => ({ env: mockEnv }));
vi.mock("@/db", () => ({ db: testDb.db }));
vi.mock("@/db/d1/client", () => ({ d1Db: testDb.db }));
vi.mock("@/db/pg/client", () => ({ pgDb: null }));
vi.mock("@/db/runBatch", () => ({ runBatch: testDb.runBatch }));
vi.mock("@/server/lib/runtime-env", () => ({
  getOptionalEnvValue: async (name: string) => {
    const values: Record<string, string> = {
      AUTOGEO_QUEUE_MASTER_KEY_B64: btoa("k".repeat(32)),
      GOOGLE_DRIVE_ARCHIVE_CLIENT_ID: "synthetic-client-id",
      GOOGLE_DRIVE_ARCHIVE_CLIENT_SECRET: "synthetic-client-secret",
      GOOGLE_DRIVE_ARCHIVE_TOKEN_KEY_B64: btoa("t".repeat(32)),
      GOOGLE_DRIVE_ARCHIVE_REDIRECT_URI:
        "https://autogeo.flexsentlabs.com/api/google-drive/archive/oauth/callback",
    };
    return values[name];
  },
}));

beforeEach(async () => {
  mockEnv.AUTH_MODE = "cloudflare_access";
  await testDb.client.executeMultiple(`
    DELETE FROM organization;
    DELETE FROM user;
    INSERT INTO organization (id, name, slug, created_at) VALUES
      ('shared-workspace', 'Shared workspace', 'shared-workspace', 0),
      ('delegated-u1', 'ben workspace', 'delegated-ben-1', 0);
    INSERT INTO user (id, name, email) VALUES
      ('drive-user', 'Drive user', 'drive-user@example.invalid');
    INSERT INTO projects (id, organization_id, name, domain) VALUES
      ('p-shared', 'shared-workspace', 'Shared project', 'shared.example'),
      ('p1-acme', 'delegated-u1', 'Acme', 'acme.example');
  `);
});

it("keeps the old Drive destination and replays a lost acknowledgement after merge", async () => {
  await testDb.db.insert(projectSettingsSnapshotRevisions).values({
    projectId: "p1-acme",
    revision: 1,
    updatedAt: "2026-11-10T00:00:00.000Z",
  });
  await testDb.db.insert(projectSettingsSnapshotOutbox).values({
    id: "pending-before-merge",
    projectId: "p1-acme",
    revision: 1,
    idempotencyKey: "open-seo:project-settings:p1-acme:1",
    algorithm: "AES-GCM-256",
    schemaVersion: 1,
    iv: "iv-before-merge",
    ciphertext: "encrypted-before-merge",
    status: "unconfirmed",
    createdAt: "2026-11-10T00:00:00.000Z",
    confirmedAt: null,
    archiveFileId: "reserved-drive-file",
  });

  const config = await readConfig();
  if (!config) throw new Error("Expected synthetic Drive OAuth config.");
  const cipher = await tokenCipher(config);
  const accessTokenCiphertext = await cipher.encrypt(
    "synthetic-access-token",
    googleDriveTokenContext(config, "delegated-u1", "google-account", "access"),
  );
  const refreshTokenCiphertext = await cipher.encrypt(
    "synthetic-refresh-token",
    googleDriveTokenContext(
      config,
      "delegated-u1",
      "google-account",
      "refresh",
    ),
  );
  await testDb.db.insert(googleDriveArchiveConnections).values({
    id: "archive-u1",
    organizationId: "delegated-u1",
    connectedByUserId: "drive-user",
    googleAccountId: "google-account",
    accountEmail: "archive@example.invalid",
    accessTokenCiphertext,
    refreshTokenCiphertext,
    accessTokenExpiresAt: "2099-01-01T00:00:00.000Z",
    scope: "drive.file",
    folderId: "folder-u1",
    folderName: "Archive",
    status: "connected",
    createdAt: "2026-11-10T00:00:00.000Z",
    updatedAt: "2026-11-10T00:00:00.000Z",
  });

  await expect(WorkspaceMergeService.mergeLegacyWorkspaces()).resolves.toEqual({
    mergedWorkspaces: 1,
  });

  const [movedConnection] = await testDb.db
    .select()
    .from(googleDriveArchiveConnections)
    .where(eq(googleDriveArchiveConnections.id, "archive-u1"));
  expect(movedConnection).toMatchObject({
    organizationId: "shared-workspace",
    googleAccountId: "google-account",
    folderId: "folder-u1",
  });
  await expect(
    cipher.decrypt(
      movedConnection!.accessTokenCiphertext,
      googleDriveTokenContext(
        config,
        "shared-workspace",
        "google-account",
        "access",
      ),
    ),
  ).resolves.toBe("synthetic-access-token");
  await expect(
    cipher.decrypt(
      movedConnection!.refreshTokenCiphertext,
      googleDriveTokenContext(
        config,
        "shared-workspace",
        "google-account",
        "refresh",
      ),
    ),
  ).resolves.toBe("synthetic-refresh-token");
  await expect(
    testDb.db
      .select({ status: projectSettingsSnapshotOutbox.status })
      .from(projectSettingsSnapshotOutbox)
      .where(eq(projectSettingsSnapshotOutbox.id, "pending-before-merge")),
  ).resolves.toMatchObject([{ status: "unconfirmed" }]);

  const remoteFiles = new Map<string, { fileId: string; ciphertext: string }>();
  const deliveryCalls: Array<{
    idempotencyKey: string;
    folderId: string;
    fileId: string;
  }> = [];
  let loseAcknowledgement = true;
  const archive: ProjectSettingsSnapshotArchivePort = {
    generateFileId: async (projectId) => `generated-${projectId}`,
    putEncryptedSnapshot: async (snapshot, fileId) => {
      const [project] = await testDb.db
        .select({ organizationId: projects.organizationId })
        .from(projects)
        .where(eq(projects.id, snapshot.projectId));
      const [connection] = await testDb.db
        .select({ folderId: googleDriveArchiveConnections.folderId })
        .from(googleDriveArchiveConnections)
        .where(
          eq(
            googleDriveArchiveConnections.organizationId,
            project!.organizationId,
          ),
        );
      if (!connection?.folderId)
        throw new Error(
          "Archive connection disappeared after workspace merge.",
        );
      const folderId = connection.folderId;
      const key = `${folderId}:${snapshot.idempotencyKey}`;
      const prior = remoteFiles.get(key);
      if (prior && prior.fileId !== fileId)
        throw new Error("Lost-ack retry changed its reserved Drive file ID.");
      remoteFiles.set(key, { fileId, ciphertext: snapshot.ciphertext });
      deliveryCalls.push({
        idempotencyKey: snapshot.idempotencyKey,
        folderId,
        fileId,
      });
      if (
        loseAcknowledgement &&
        snapshot.idempotencyKey === "open-seo:project-settings:p1-acme:1"
      ) {
        loseAcknowledgement = false;
        throw new Error("Synthetic Drive acknowledgement was lost.");
      }
    },
  };

  await expect(
    deliverPendingProjectSettingsSnapshots(archive),
  ).resolves.toMatchObject({ attempted: 1, confirmed: 0, unconfirmed: 1 });
  await expect(
    deliverPendingProjectSettingsSnapshots(archive),
  ).resolves.toMatchObject({ attempted: 1, confirmed: 1, unconfirmed: 0 });
  await expect(
    deliverPendingProjectSettingsSnapshots(archive),
  ).resolves.toMatchObject({ attempted: 1, confirmed: 1, unconfirmed: 0 });
  expect(deliveryCalls).toEqual([
    {
      idempotencyKey: "open-seo:project-settings:p1-acme:1",
      folderId: "folder-u1",
      fileId: "reserved-drive-file",
    },
    {
      idempotencyKey: "open-seo:project-settings:p1-acme:1",
      folderId: "folder-u1",
      fileId: "reserved-drive-file",
    },
    {
      idempotencyKey: "open-seo:project-settings:p1-acme:2",
      folderId: "folder-u1",
      fileId: "generated-p1-acme",
    },
  ]);
  expect(remoteFiles.size).toBe(2);
  await expect(
    testDb.db
      .select({ status: projectSettingsSnapshotOutbox.status })
      .from(projectSettingsSnapshotOutbox)
      .where(eq(projectSettingsSnapshotOutbox.id, "pending-before-merge")),
  ).resolves.toMatchObject([{ status: "confirmed" }]);
});

it("fails closed when a workspace merge would collapse two archive destinations", async () => {
  await testDb.db.insert(googleDriveArchiveConnections).values([
    {
      id: "archive-legacy",
      organizationId: "delegated-u1",
      connectedByUserId: "drive-user",
      googleAccountId: "account-one",
      accountEmail: "one@example.invalid",
      accessTokenCiphertext: "encrypted-one",
      refreshTokenCiphertext: "encrypted-one",
      accessTokenExpiresAt: "2099-01-01T00:00:00.000Z",
      scope: "drive.file",
      folderId: "folder-one",
      folderName: "One",
      status: "connected",
    },
    {
      id: "archive-shared",
      organizationId: "shared-workspace",
      connectedByUserId: "drive-user",
      googleAccountId: "account-two",
      accountEmail: "two@example.invalid",
      accessTokenCiphertext: "encrypted-two",
      refreshTokenCiphertext: "encrypted-two",
      accessTokenExpiresAt: "2099-01-01T00:00:00.000Z",
      scope: "drive.file",
      folderId: "folder-two",
      folderName: "Two",
      status: "connected",
    },
  ]);

  await expect(
    WorkspaceMergeService.mergeLegacyWorkspaces(),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(
    testDb.db
      .select({ id: organization.id })
      .from(organization)
      .where(eq(organization.id, "delegated-u1")),
  ).resolves.toHaveLength(1);
  const connections = await testDb.db
    .select({
      id: googleDriveArchiveConnections.id,
      organizationId: googleDriveArchiveConnections.organizationId,
    })
    .from(googleDriveArchiveConnections)
    .orderBy(googleDriveArchiveConnections.id);
  expect(connections).toEqual([
    { id: "archive-legacy", organizationId: "delegated-u1" },
    { id: "archive-shared", organizationId: "shared-workspace" },
  ]);
  await expect(
    testDb.db
      .select({ id: projectSettingsSnapshotOutbox.id })
      .from(projectSettingsSnapshotOutbox),
  ).resolves.toHaveLength(0);
});

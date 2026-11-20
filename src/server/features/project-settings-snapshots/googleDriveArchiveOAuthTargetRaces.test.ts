import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const state = await vi.hoisted(async () => {
  const { createAiVisibilityTestDb } =
    await import("@/server/features/ai-visibility/aiVisibilityTestDb");
  return {
    testDb: await createAiVisibilityTestDb(),
    env: {} as Record<string, string>,
  };
});

vi.mock("@/db", () => ({ db: state.testDb.db }));
vi.mock("@/db/runBatch", () => ({ runBatch: state.testDb.runBatch }));
vi.mock("cloudflare:workers", () => ({ env: { DATABASE_PROVIDER: "d1" } }));
vi.mock("@/middleware/ensure-user/resolve", () => ({
  resolveUserContextFromHeaders: async () => ({
    userId: "open-seo-user-1",
    organizationId: "organization",
    role: "owner",
  }),
}));
vi.mock("@/server/lib/runtime-env", () => ({
  getOptionalEnvValue: async (name: string) => state.env[name],
}));

import { db } from "@/db";
import {
  googleDriveArchiveConnections,
  projectSettingsSnapshotOutbox,
  verification,
} from "@/db/schema";
import { handleGoogleDriveArchiveRequest } from "./googleDriveArchiveOAuthRoutes";
import { callbackProbeAwareFetch } from "./googleDriveArchiveCallbackTestUtils";
import {
  deliverPendingProjectSettingsSnapshots,
  type ProjectSettingsSnapshotArchivePort,
} from "./snapshotDelivery";
import {
  googleDriveTokenContext,
  readConfig,
  tokenCipher,
} from "./googleDriveArchiveOAuthShared";

const ORIGIN = "https://autogeo.flexsentlabs.com";
const CALLBACK = ORIGIN + "/api/google-drive/archive/oauth/callback";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const ENCRYPTION_KEY_B64 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

function setSyntheticConfig() {
  Object.assign(state.env, {
    GOOGLE_DRIVE_ARCHIVE_CLIENT_ID:
      "synthetic-client-id.apps.googleusercontent.com",
    GOOGLE_DRIVE_ARCHIVE_CLIENT_SECRET: "synthetic-oauth-client-secret",
    GOOGLE_DRIVE_ARCHIVE_TOKEN_KEY_B64: ENCRYPTION_KEY_B64,
    GOOGLE_DRIVE_ARCHIVE_REDIRECT_URI: CALLBACK,
    GOOGLE_DRIVE_ARCHIVE_PICKER_API_KEY: "synthetic-picker-key",
    GOOGLE_DRIVE_ARCHIVE_PROJECT_NUMBER: "123456789",
  });
}

function sameOriginHeaders() {
  return {
    origin: ORIGIN,
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
  };
}

function requireResponse(response: Response | null): Response {
  if (!response) throw new Error("Google Drive archive route was not handled.");
  return response;
}

beforeEach(async () => {
  Object.keys(state.env).forEach((key) => delete state.env[key]);
  setSyntheticConfig();
  await db.delete(googleDriveArchiveConnections);
  await db.delete(verification);
  await state.testDb.seedProject();
  await state.testDb.client.execute(
    "INSERT OR IGNORE INTO user (id, name, email) VALUES ('open-seo-user-1', 'Acceptance User', 'acceptance@example.invalid')",
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function seedConnectedArchive(folderId: string) {
  const config = await readConfig();
  if (!config) throw new Error("Expected synthetic Drive configuration.");
  const cipher = await tokenCipher(config);
  await db.insert(googleDriveArchiveConnections).values({
    id: "connection-race-test",
    organizationId: "organization",
    connectedByUserId: "open-seo-user-1",
    googleAccountId: "google-account-1",
    accountEmail: "acceptance@example.invalid",
    accessTokenCiphertext: await cipher.encrypt(
      "synthetic-google-access-token",
      googleDriveTokenContext(
        config,
        "organization",
        "google-account-1",
        "access",
      ),
    ),
    refreshTokenCiphertext: await cipher.encrypt(
      "synthetic-google-refresh-token",
      googleDriveTokenContext(
        config,
        "organization",
        "google-account-1",
        "refresh",
      ),
    ),
    accessTokenExpiresAt: "2099-01-01T00:00:00.000Z",
    scope: DRIVE_SCOPE,
    folderId,
    folderName: "Acceptance archive",
    status: "connected",
    createdAt: "2026-11-17T00:00:00.000Z",
    updatedAt: "2026-11-17T00:00:00.000Z",
  });
  return { connectionId: "connection-race-test", config };
}

it("blocks a folder change that races with target-bound ID reservation", async () => {
  const { connectionId } = await seedConnectedArchive("folder-valid-123");
  await db.insert(projectSettingsSnapshotOutbox).values({
    id: "outbox-folder-race",
    projectId: "project",
    revision: 1,
    idempotencyKey: "open-seo:project-settings:project:1",
    algorithm: "AES-GCM-256",
    schemaVersion: 1,
    iv: "synthetic-iv",
    ciphertext: "synthetic-ciphertext",
    archiveFileId: null,
    status: "unconfirmed",
    createdAt: "2026-11-17T00:00:00.000Z",
    confirmedAt: null,
  });

  let releaseFolderVerification!: () => void;
  let folderVerificationStarted!: () => void;
  const folderVerification = new Promise<void>((resolve) => {
    releaseFolderVerification = resolve;
  });
  const verificationStarted = new Promise<void>((resolve) => {
    folderVerificationStarted = resolve;
  });
  const verifyFolderFetch = vi.fn(async () => {
    folderVerificationStarted();
    await folderVerification;
    return Response.json({
      id: "folder-new-123",
      name: "New archive",
      mimeType: "application/vnd.google-apps.folder",
      trashed: false,
      capabilities: { canAddChildren: true },
    });
  });
  vi.stubGlobal("fetch", callbackProbeAwareFetch(verifyFolderFetch));

  const folderChange = handleGoogleDriveArchiveRequest(
    new Request(ORIGIN + "/api/google-drive/archive/folder", {
      method: "PUT",
      headers: sameOriginHeaders(),
      body: JSON.stringify({ id: "folder-new-123" }),
    }),
  );
  await verificationStarted;

  const archive: ProjectSettingsSnapshotArchivePort = {
    generateFileId: async () => ({
      fileId: "reserved-during-folder-check",
      target: {
        connectionId,
        organizationId: "organization",
        googleAccountId: "google-account-1",
        folderId: "folder-valid-123",
      },
    }),
    putEncryptedSnapshot: async () => {
      throw new Error("synthetic archive offline");
    },
  };
  await expect(
    deliverPendingProjectSettingsSnapshots(archive),
  ).resolves.toEqual({ attempted: 1, confirmed: 0, unconfirmed: 1 });
  releaseFolderVerification();

  const folderResponse = requireResponse(await folderChange);
  expect(folderResponse.status).toBe(409);
  expect(await folderResponse.json()).toEqual({
    error: "archive_target_change_blocked",
  });
  const [connection] = await db
    .select({ folderId: googleDriveArchiveConnections.folderId })
    .from(googleDriveArchiveConnections)
    .where(eq(googleDriveArchiveConnections.id, connectionId))
    .limit(1);
  expect(connection?.folderId).toBe("folder-valid-123");
  const [outbox] = await db
    .select({ archiveFileId: projectSettingsSnapshotOutbox.archiveFileId })
    .from(projectSettingsSnapshotOutbox)
    .where(eq(projectSettingsSnapshotOutbox.id, "outbox-folder-race"))
    .limit(1);
  expect(outbox?.archiveFileId).toBe("reserved-during-folder-check");
});

it("keeps a connection when disconnect races with target-bound ID reservation", async () => {
  const { connectionId } = await seedConnectedArchive("folder-valid-123");
  await db.insert(projectSettingsSnapshotOutbox).values({
    id: "outbox-disconnect-race",
    projectId: "project",
    revision: 1,
    idempotencyKey: "open-seo:project-settings:project:1",
    algorithm: "AES-GCM-256",
    schemaVersion: 1,
    iv: "synthetic-iv",
    ciphertext: "synthetic-ciphertext",
    archiveFileId: null,
    status: "unconfirmed",
    createdAt: "2026-11-17T00:00:00.000Z",
    confirmedAt: null,
  });

  let releaseTokenDecryption!: () => void;
  let tokenDecryptionStarted!: () => void;
  const tokenDecryption = new Promise<void>((resolve) => {
    releaseTokenDecryption = resolve;
  });
  const decryptionStarted = new Promise<void>((resolve) => {
    tokenDecryptionStarted = resolve;
  });
  const decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
  let decryptCalls = 0;
  vi.spyOn(crypto.subtle, "decrypt").mockImplementation(
    async (algorithm, key, data) => {
      decryptCalls++;
      if (decryptCalls === 1) {
        tokenDecryptionStarted();
        await tokenDecryption;
      }
      return decrypt(algorithm, key, data);
    },
  );

  const disconnect = handleGoogleDriveArchiveRequest(
    new Request(ORIGIN + "/api/google-drive/archive/connection", {
      method: "DELETE",
      headers: sameOriginHeaders(),
    }),
  );
  await decryptionStarted;
  const archive: ProjectSettingsSnapshotArchivePort = {
    generateFileId: async () => ({
      fileId: "reserved-during-disconnect",
      target: {
        connectionId,
        organizationId: "organization",
        googleAccountId: "google-account-1",
        folderId: "folder-valid-123",
      },
    }),
    putEncryptedSnapshot: async () => {
      throw new Error("synthetic archive offline");
    },
  };
  await expect(
    deliverPendingProjectSettingsSnapshots(archive),
  ).resolves.toEqual({ attempted: 1, confirmed: 0, unconfirmed: 1 });
  releaseTokenDecryption();

  const response = requireResponse(await disconnect);
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    error: "archive_target_change_blocked",
  });
  const [connection] = await db
    .select({ id: googleDriveArchiveConnections.id })
    .from(googleDriveArchiveConnections)
    .where(eq(googleDriveArchiveConnections.id, connectionId))
    .limit(1);
  expect(connection?.id).toBe(connectionId);
});

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
import {
  accessTokenForConnection,
  saveConnection,
} from "./googleDriveArchiveOAuth";
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

it("blocks a reconnect that races with target-bound ID reservation", async () => {
  const { config } = await seedConnectedArchive("folder-valid-123");
  let releaseTokenEncryption!: () => void;
  let tokenEncryptionStarted!: () => void;
  const tokenEncryption = new Promise<void>((resolve) => {
    releaseTokenEncryption = resolve;
  });
  const encryptionStarted = new Promise<void>((resolve) => {
    tokenEncryptionStarted = resolve;
  });
  const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
  let encryptCalls = 0;
  vi.spyOn(crypto.subtle, "encrypt").mockImplementation(
    async (algorithm, key, data) => {
      encryptCalls++;
      if (encryptCalls === 1) {
        tokenEncryptionStarted();
        await tokenEncryption;
      }
      return encrypt(algorithm, key, data);
    },
  );

  const reconnect = saveConnection({
    config,
    state: {
      userId: "open-seo-user-1",
      organizationId: "organization",
      redirectUri: CALLBACK,
      browserBindingHash: "a".repeat(43),
    },
    tokens: {
      access_token: "replacement-access-token",
      refresh_token: "replacement-refresh-token",
      expires_in: 3600,
      scope: DRIVE_SCOPE,
    },
    googleAccountId: "google-account-2",
    accountEmail: "replacement@example.invalid",
  });
  await encryptionStarted;

  await db.insert(projectSettingsSnapshotOutbox).values({
    id: "outbox-reconnect-race",
    projectId: "project",
    revision: 1,
    idempotencyKey: "open-seo:project-settings:project:1",
    algorithm: "AES-GCM-256",
    schemaVersion: 1,
    iv: "synthetic-iv",
    ciphertext: "synthetic-ciphertext",
    archiveFileId: "reserved-before-reconnect-commit",
    status: "unconfirmed",
    createdAt: "2026-11-17T00:00:00.000Z",
    confirmedAt: null,
  });
  releaseTokenEncryption();

  await expect(reconnect).rejects.toThrow(
    "google_drive_archive_target_change_blocked",
  );
  const [connection] = await db
    .select({
      googleAccountId: googleDriveArchiveConnections.googleAccountId,
      folderId: googleDriveArchiveConnections.folderId,
    })
    .from(googleDriveArchiveConnections)
    .where(eq(googleDriveArchiveConnections.organizationId, "organization"))
    .limit(1);
  expect(connection).toEqual({
    googleAccountId: "google-account-1",
    folderId: "folder-valid-123",
  });
});

it("does not let a stale token refresh overwrite a replacement connection", async () => {
  const { config } = await seedConnectedArchive("folder-valid-123");
  await db
    .update(googleDriveArchiveConnections)
    .set({ accessTokenExpiresAt: "2000-01-01T00:00:00.000Z" })
    .where(eq(googleDriveArchiveConnections.organizationId, "organization"));
  const [staleConnection] = await db
    .select()
    .from(googleDriveArchiveConnections)
    .where(eq(googleDriveArchiveConnections.organizationId, "organization"))
    .limit(1);
  if (!staleConnection) throw new Error("Expected a connected Drive account.");

  let releaseRefreshResponse!: () => void;
  let refreshRequestStarted!: () => void;
  const refreshResponse = new Promise<void>((resolve) => {
    releaseRefreshResponse = resolve;
  });
  const refreshStarted = new Promise<void>((resolve) => {
    refreshRequestStarted = resolve;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      refreshRequestStarted();
      await refreshResponse;
      return Response.json({
        access_token: "stale-account-refreshed-token",
        expires_in: 3600,
      });
    }),
  );
  const refresh = accessTokenForConnection(staleConnection, config);
  await refreshStarted;

  await saveConnection({
    config,
    state: {
      userId: "open-seo-user-1",
      organizationId: "organization",
      redirectUri: CALLBACK,
      browserBindingHash: "a".repeat(43),
    },
    tokens: {
      access_token: "replacement-access-token",
      refresh_token: "replacement-refresh-token",
      expires_in: 3600,
      scope: DRIVE_SCOPE,
    },
    googleAccountId: "google-account-2",
    accountEmail: "replacement@example.invalid",
  });
  releaseRefreshResponse();

  await expect(refresh).rejects.toThrow(
    "Google Drive connection changed during token refresh.",
  );
  const [replacement] = await db
    .select()
    .from(googleDriveArchiveConnections)
    .where(eq(googleDriveArchiveConnections.organizationId, "organization"))
    .limit(1);
  expect(replacement).toMatchObject({
    googleAccountId: "google-account-2",
    folderId: null,
  });
  if (!replacement) throw new Error("Expected replacement Drive account.");
  const cipher = await tokenCipher(config);
  await expect(
    cipher.decrypt(
      replacement.accessTokenCiphertext,
      googleDriveTokenContext(
        config,
        "organization",
        "google-account-2",
        "access",
      ),
    ),
  ).resolves.toBe("replacement-access-token");
});

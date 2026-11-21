import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const state = await vi.hoisted(async () => {
  const { createAiVisibilityTestDb } =
    await import("@/server/features/ai-visibility/aiVisibilityTestDb");
  return {
    testDb: await createAiVisibilityTestDb(),
    env: {} as Record<string, string>,
    databaseProvider: "d1" as "d1" | "postgres",
    transactionExecutor: null as unknown,
    events: [] as string[],
  };
});

vi.mock("@/db", () => ({ db: state.testDb.db }));
vi.mock("@/db/provider", () => ({
  getDatabaseProvider: () => state.databaseProvider,
}));
vi.mock("@/db/runBatch", () => ({
  runBatch: state.testDb.runBatch,
  runPostgresTransaction: async (work: unknown) => {
    if (typeof work !== "function")
      throw new Error("Expected a Postgres transaction callback.");
    const result: unknown = Reflect.apply(work, undefined, [
      state.transactionExecutor,
    ]);
    await result;
  },
}));
vi.mock("cloudflare:workers", () => ({ env: { DATABASE_PROVIDER: "d1" } }));
vi.mock("@/server/lib/runtime-env", () => ({
  getOptionalEnvValue: async (name: string) => state.env[name],
}));

import { db } from "@/db";
import {
  googleDriveArchiveConnections,
  projectSettingsSnapshotOutbox,
  verification,
} from "@/db/schema";
import { saveConnection } from "./googleDriveArchiveOAuth";
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

async function seedConnectedArchive() {
  const config = await readConfig();
  if (!config) throw new Error("Expected synthetic Drive configuration.");
  const cipher = await tokenCipher(config);
  await db.insert(googleDriveArchiveConnections).values({
    id: "connection-postgres-race-test",
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
    folderId: "folder-valid-123",
    folderName: "Acceptance archive",
    status: "connected",
    createdAt: "2026-11-17T00:00:00.000Z",
    updatedAt: "2026-11-17T00:00:00.000Z",
  });
}

beforeEach(async () => {
  state.databaseProvider = "d1";
  state.transactionExecutor = null;
  state.events = [];
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
  vi.restoreAllMocks();
});

it("rechecks pending snapshots after locking the organization connection", async () => {
  await seedConnectedArchive();
  state.databaseProvider = "postgres";

  const tx = {
    update: () => ({
      set: () => ({
        where: async () => {
          state.events.push("connection-lock-acquired");
          return [];
        },
      }),
    }),
    select: () => {
      let source: unknown;
      const query = {
        from(table: unknown) {
          source = table;
          return query;
        },
        innerJoin() {
          return query;
        },
        where() {
          return query;
        },
        limit() {
          if (source === googleDriveArchiveConnections) {
            state.events.push("connection-read-after-lock");
            return Promise.resolve([{ googleAccountId: "google-account-1" }]);
          }
          if (source === projectSettingsSnapshotOutbox) {
            state.events.push("pending-read-after-lock");
            return Promise.resolve([{ id: "reserved-outbox-row" }]);
          }
          throw new Error("Unexpected Postgres transaction query.");
        },
      };
      return query;
    },
    insert: () => {
      state.events.push("unexpected-connection-upsert");
      throw new Error("Reconnect must stop before changing the connection.");
    },
  };
  state.transactionExecutor = tx;

  const config = await readConfig();
  if (!config) throw new Error("Expected synthetic Drive configuration.");
  await expect(
    saveConnection({
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
    }),
  ).rejects.toThrow("google_drive_archive_target_change_blocked");

  expect(state.events).toEqual([
    "connection-lock-acquired",
    "connection-read-after-lock",
    "pending-read-after-lock",
  ]);
  const [connection] = await db
    .select({ googleAccountId: googleDriveArchiveConnections.googleAccountId })
    .from(googleDriveArchiveConnections)
    .where(eq(googleDriveArchiveConnections.organizationId, "organization"))
    .limit(1);
  expect(connection?.googleAccountId).toBe("google-account-1");
});

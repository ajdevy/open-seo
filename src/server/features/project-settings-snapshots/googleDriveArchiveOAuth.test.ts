import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { z } from "zod";

const state = await vi.hoisted(async () => {
  const { createAiVisibilityTestDb } =
    await import("@/server/features/ai-visibility/aiVisibilityTestDb");
  let role: "owner" | "admin" | "member" = "owner";
  let userId = "open-seo-user-1";
  let organizationId = "organization";
  return {
    testDb: await createAiVisibilityTestDb(),
    env: {} as Record<string, string>,
    accountId: "google-account-1",
    setRole(value: typeof role) {
      role = value;
    },
    setIdentity(input: { userId?: string; organizationId?: string }) {
      userId = input.userId ?? userId;
      organizationId = input.organizationId ?? organizationId;
    },
    resetIdentity() {
      userId = "open-seo-user-1";
      organizationId = "organization";
    },
    userContext: () => ({
      userId,
      organizationId,
      role,
    }),
  };
});

vi.mock("@/db", () => ({ db: state.testDb.db }));
vi.mock("@/db/runBatch", () => ({ runBatch: state.testDb.runBatch }));
vi.mock("cloudflare:workers", () => ({ env: { DATABASE_PROVIDER: "d1" } }));
vi.mock("@/middleware/ensure-user/resolve", () => ({
  resolveUserContextFromHeaders: async () => state.userContext(),
}));
vi.mock("@/server/features/google/googleIdToken", () => ({
  getGoogleAccountId: async () => state.accountId,
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
import { handleGoogleDriveArchiveOAuthCallback } from "./googleDriveArchiveOAuthCallback";
import { handleGoogleDriveArchiveRequest } from "./googleDriveArchiveOAuthRoutes";

const ORIGIN = "https://autogeo.flexsentlabs.com";
const CALLBACK = ORIGIN + "/api/google-drive/archive/oauth/callback";
const CLIENT_SECRET = "synthetic-oauth-client-secret";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const ENCRYPTION_KEY_B64 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

function setSyntheticConfig() {
  Object.assign(state.env, {
    GOOGLE_DRIVE_ARCHIVE_CLIENT_ID:
      "synthetic-client-id.apps.googleusercontent.com",
    GOOGLE_DRIVE_ARCHIVE_CLIENT_SECRET: CLIENT_SECRET,
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

async function jsonBody<T>(response: Response, schema: z.ZodType<T>) {
  return schema.parse(await response.json());
}

beforeEach(async () => {
  state.setRole("owner");
  state.resetIdentity();
  state.accountId = "google-account-1";
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

it("stores OAuth tokens encrypted and only returns a no-store Picker token", async () => {
  const startResponse = requireResponse(
    await handleGoogleDriveArchiveRequest(
      new Request(ORIGIN + "/api/google-drive/archive/oauth/start", {
        method: "POST",
        headers: sameOriginHeaders(),
      }),
    ),
  );
  const startBody = await jsonBody(
    startResponse,
    z.object({
      authorizationUrl: z.string().url(),
      browserBinding: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
    }),
  );
  const stateToken = new URL(startBody.authorizationUrl).searchParams.get(
    "state",
  );
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url =
      input instanceof Request
        ? input.url
        : input instanceof URL
          ? input.href
          : input;
    if (url === "https://oauth2.googleapis.com/token")
      return Response.json({
        access_token: "synthetic-google-access-token",
        refresh_token: "synthetic-google-refresh-token",
        expires_in: 3600,
        scope: DRIVE_SCOPE,
      });
    if (url.startsWith("https://www.googleapis.com/drive/v3/about?"))
      return Response.json({
        user: {
          permissionId: state.accountId,
          me: true,
        },
      });
    if (url.startsWith("https://www.googleapis.com/drive/v3/files/folder-")) {
      const folderId = new URL(url).pathname.split("/").at(-1);
      return Response.json({
        id: folderId,
        name: "Acceptance archive",
        mimeType: "application/vnd.google-apps.folder",
        trashed: false,
        capabilities: { canAddChildren: folderId === "folder-valid-123" },
      });
    }
    return new Response(null, { status: 404 });
  });
  vi.stubGlobal("fetch", fetcher);

  const callback = await handleGoogleDriveArchiveOAuthCallback(
    new Request(CALLBACK + "?code=synthetic-code&state=" + stateToken),
  );
  expect(callback.status).toBe(200);
  expect(callback.headers.get("content-type")).toContain("text/html");
  expect(await callback.text()).toContain("oauth/complete");
  expect(fetcher).not.toHaveBeenCalled();
  const completion = requireResponse(
    await handleGoogleDriveArchiveRequest(
      new Request(ORIGIN + "/api/google-drive/archive/oauth/complete", {
        method: "POST",
        headers: sameOriginHeaders(),
        body: JSON.stringify({
          state: stateToken,
          browserBinding: startBody.browserBinding,
          code: "synthetic-code",
          authorizationDenied: false,
        }),
      }),
    ),
  );
  expect(completion.status).toBe(200);
  expect(await completion.json()).toEqual({ connected: true });
  expect(fetcher).toHaveBeenCalledTimes(2);
  const [connection] = await db
    .select()
    .from(googleDriveArchiveConnections)
    .where(eq(googleDriveArchiveConnections.organizationId, "organization"))
    .limit(1);
  expect(connection).toMatchObject({
    organizationId: "organization",
    googleAccountId: state.accountId,
    accountEmail: null,
    folderId: null,
    status: "connected",
  });
  expect(connection?.accessTokenCiphertext).not.toContain(
    "synthetic-google-access-token",
  );
  expect(connection?.refreshTokenCiphertext).not.toContain(
    "synthetic-google-refresh-token",
  );
  expect(connection?.accessTokenCiphertext).toMatch(/^v2\./u);
  expect(connection?.refreshTokenCiphertext).toMatch(/^v2\./u);

  const pickerResponse = requireResponse(
    await handleGoogleDriveArchiveRequest(
      new Request(ORIGIN + "/api/google-drive/archive/picker-token", {
        method: "POST",
        headers: sameOriginHeaders(),
      }),
    ),
  );
  const pickerBody = await jsonBody(
    pickerResponse,
    z.object({
      accessToken: z.string(),
      apiKey: z.string(),
      projectNumber: z.string(),
    }),
  );
  expect(pickerBody).toEqual({
    accessToken: "synthetic-google-access-token",
    apiKey: "synthetic-picker-key",
    projectNumber: "123456789",
  });
  expect(pickerResponse.headers.get("cache-control")).toContain("no-store");
  expect(pickerResponse.headers.get("pragma")).toBe("no-cache");

  const folderResponse = requireResponse(
    await handleGoogleDriveArchiveRequest(
      new Request(ORIGIN + "/api/google-drive/archive/folder", {
        method: "PUT",
        headers: sameOriginHeaders(),
        body: JSON.stringify({ id: "folder-valid-123" }),
      }),
    ),
  );
  expect(folderResponse.status).toBe(200);
  expect(
    await jsonBody(
      folderResponse,
      z.object({ folder: z.object({ id: z.string(), name: z.string() }) }),
    ),
  ).toEqual({ folder: { id: "folder-valid-123", name: "Acceptance archive" } });

  const invalidFolderResponse = requireResponse(
    await handleGoogleDriveArchiveRequest(
      new Request(ORIGIN + "/api/google-drive/archive/folder", {
        method: "PUT",
        headers: sameOriginHeaders(),
        body: JSON.stringify({ id: "folder-invalid-123" }),
      }),
    ),
  );
  expect(invalidFolderResponse.status).toBe(503);

  await db.insert(projectSettingsSnapshotOutbox).values({
    id: "outbox-target-bound",
    projectId: "project",
    revision: 1,
    idempotencyKey: "open-seo:project-settings:project:1",
    algorithm: "AES-GCM-256",
    schemaVersion: 1,
    iv: "synthetic-iv",
    ciphertext: "synthetic-ciphertext",
    archiveFileId: "reserved-drive-file-id",
    status: "unconfirmed",
    createdAt: "2026-11-16T00:00:00.000Z",
    confirmedAt: null,
  });

  const changedFolderResponse = requireResponse(
    await handleGoogleDriveArchiveRequest(
      new Request(ORIGIN + "/api/google-drive/archive/folder", {
        method: "PUT",
        headers: sameOriginHeaders(),
        body: JSON.stringify({ id: "folder-other-123" }),
      }),
    ),
  );
  expect(changedFolderResponse.status).toBe(409);
  expect(await changedFolderResponse.json()).toEqual({
    error: "archive_target_change_blocked",
  });

  const disconnectResponse = requireResponse(
    await handleGoogleDriveArchiveRequest(
      new Request(ORIGIN + "/api/google-drive/archive/connection", {
        method: "DELETE",
        headers: sameOriginHeaders(),
      }),
    ),
  );
  expect(disconnectResponse.status).toBe(409);
  expect(await disconnectResponse.json()).toEqual({
    error: "archive_target_change_blocked",
  });

  const reconnectStartResponse = requireResponse(
    await handleGoogleDriveArchiveRequest(
      new Request(ORIGIN + "/api/google-drive/archive/oauth/start", {
        method: "POST",
        headers: sameOriginHeaders(),
      }),
    ),
  );
  const reconnectStartBody = await jsonBody(
    reconnectStartResponse,
    z.object({
      authorizationUrl: z.string().url(),
      browserBinding: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
    }),
  );
  const reconnectState = new URL(
    reconnectStartBody.authorizationUrl,
  ).searchParams.get("state");
  state.accountId = "google-account-2";
  const reconnectCallback = await handleGoogleDriveArchiveOAuthCallback(
    new Request(CALLBACK + "?code=synthetic-code&state=" + reconnectState),
  );
  expect(reconnectCallback.status).toBe(200);
  const reconnectCompletion = requireResponse(
    await handleGoogleDriveArchiveRequest(
      new Request(ORIGIN + "/api/google-drive/archive/oauth/complete", {
        method: "POST",
        headers: sameOriginHeaders(),
        body: JSON.stringify({
          state: reconnectState,
          browserBinding: reconnectStartBody.browserBinding,
          code: "synthetic-code",
          authorizationDenied: false,
        }),
      }),
    ),
  );
  expect(reconnectCompletion.status).toBe(409);
  expect(await reconnectCompletion.json()).toEqual({
    error: "archive_target_change_blocked",
  });

  const [savedConnection] = await db
    .select()
    .from(googleDriveArchiveConnections)
    .where(eq(googleDriveArchiveConnections.organizationId, "organization"))
    .limit(1);
  expect(savedConnection).toMatchObject({
    googleAccountId: "google-account-1",
    folderId: "folder-valid-123",
  });
});

it("rejects OAuth tokens that include scopes beyond drive.file", async () => {
  const startResponse = requireResponse(
    await handleGoogleDriveArchiveRequest(
      new Request(ORIGIN + "/api/google-drive/archive/oauth/start", {
        method: "POST",
        headers: sameOriginHeaders(),
      }),
    ),
  );
  const startBody = await jsonBody(
    startResponse,
    z.object({
      authorizationUrl: z.string().url(),
      browserBinding: z.string(),
    }),
  );
  const stateToken = new URL(startBody.authorizationUrl).searchParams.get(
    "state",
  );
  const fetcher = vi.fn(async () =>
    Response.json({
      access_token: "synthetic-google-access-token",
      refresh_token: "synthetic-google-refresh-token",
      expires_in: 3600,
      scope: `${DRIVE_SCOPE} email`,
    }),
  );
  vi.stubGlobal("fetch", fetcher);

  const response = requireResponse(
    await handleGoogleDriveArchiveRequest(
      new Request(ORIGIN + "/api/google-drive/archive/oauth/complete", {
        method: "POST",
        headers: sameOriginHeaders(),
        body: JSON.stringify({
          state: stateToken,
          browserBinding: startBody.browserBinding,
          code: "synthetic-code",
          authorizationDenied: false,
        }),
      }),
    ),
  );

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "google_scope_invalid" });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(
    await db
      .select({ id: googleDriveArchiveConnections.id })
      .from(googleDriveArchiveConnections),
  ).toHaveLength(0);
});

it("clears callback query parameters before rejecting an expired state", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  const callback = await handleGoogleDriveArchiveOAuthCallback(
    new Request(CALLBACK + "?code=synthetic-code&state=invalid"),
  );

  expect(callback.status).toBe(200);
  expect(callback.headers.get("cache-control")).toContain("no-store");
  expect(await callback.text()).toContain(
    'window.history.replaceState(null, "", window.location.pathname)',
  );
  expect(fetcher).not.toHaveBeenCalled();
});

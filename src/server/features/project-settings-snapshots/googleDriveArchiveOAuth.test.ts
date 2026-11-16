import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { eq, like } from "drizzle-orm";
import { z } from "zod";

const state = await vi.hoisted(async () => {
  const { createAiVisibilityTestDb } =
    await import("@/server/features/ai-visibility/aiVisibilityTestDb");
  let role: "owner" | "admin" | "member" = "owner";
  return {
    testDb: await createAiVisibilityTestDb(),
    env: {} as Record<string, string>,
    accountId: "google-account-1",
    setRole(value: typeof role) {
      role = value;
    },
    userContext: () => ({
      userId: "open-seo-user-1",
      organizationId: "organization",
      role,
    }),
  };
});

vi.mock("@/db", () => ({ db: state.testDb.db }));
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
import { handleGoogleDriveArchiveOAuthCallback } from "./googleDriveArchiveOAuth";
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

function base64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
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
});

it("starts drive.file OAuth with single-use state and PKCE", async () => {
  const response = requireResponse(
    await handleGoogleDriveArchiveRequest(
      new Request(ORIGIN + "/api/google-drive/archive/oauth/start", {
        method: "POST",
        headers: sameOriginHeaders(),
      }),
    ),
  );

  expect(response.status).toBe(200);
  const body = await jsonBody(
    response,
    z.object({ authorizationUrl: z.string().url() }),
  );
  const url = new URL(body.authorizationUrl);
  const stateToken = url.searchParams.get("state");
  const challenge = url.searchParams.get("code_challenge");
  expect(stateToken).toMatch(/^[A-Za-z0-9_-]{40,64}$/u);
  expect(url.searchParams.get("scope")?.split(" ")).toEqual([
    "openid",
    "email",
    DRIVE_SCOPE,
  ]);
  expect(url.searchParams.get("redirect_uri")).toBe(CALLBACK);
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  expect(url.searchParams.has("client_secret")).toBe(false);
  const [storedState] = await db
    .select()
    .from(verification)
    .where(like(verification.identifier, "google-drive-archive:%"));
  expect(storedState?.identifier).toBe(`google-drive-archive:${stateToken}`);

  const hmacKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(
      "open-seo:google-drive-archive:pkce:" + CLIENT_SECRET,
    ),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const verifier = base64Url(
    new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        hmacKey,
        new TextEncoder().encode(stateToken ?? ""),
      ),
    ),
  );
  const expectedChallenge = base64Url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    ),
  );
  expect(challenge).toBe(expectedChallenge);
  expect(response.headers.get("cache-control")).toContain("no-store");
});

it("rejects non-admin and cross-origin management requests", async () => {
  state.setRole("member");
  const nonAdmin = requireResponse(
    await handleGoogleDriveArchiveRequest(
      new Request(ORIGIN + "/api/google-drive/archive/oauth/start", {
        method: "POST",
        headers: sameOriginHeaders(),
      }),
    ),
  );
  expect(nonAdmin.status).toBe(403);

  state.setRole("owner");
  const crossOrigin = requireResponse(
    await handleGoogleDriveArchiveRequest(
      new Request(ORIGIN + "/api/google-drive/archive/oauth/start", {
        method: "POST",
        headers: { ...sameOriginHeaders(), origin: "https://attacker.example" },
      }),
    ),
  );
  expect(crossOrigin.status).toBe(403);
  const stateRows = await db
    .select()
    .from(verification)
    .where(like(verification.identifier, "google-drive-archive:%"));
  expect(stateRows).toHaveLength(0);
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
    z.object({ authorizationUrl: z.string().url() }),
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
        scope: ["openid", "email", DRIVE_SCOPE].join(" "),
        id_token: "synthetic-id-token",
      });
    if (url === "https://openidconnect.googleapis.com/v1/userinfo")
      return Response.json({
        sub: state.accountId,
        email: "acceptance@example.invalid",
        email_verified: true,
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
  expect(callback.status).toBe(303);
  expect(callback.headers.get("location")).toBe(
    "/settings?googleDriveArchive=connected",
  );
  expect(fetcher).toHaveBeenCalledTimes(2);
  const [connection] = await db
    .select()
    .from(googleDriveArchiveConnections)
    .where(eq(googleDriveArchiveConnections.organizationId, "organization"))
    .limit(1);
  expect(connection).toMatchObject({
    organizationId: "organization",
    googleAccountId: state.accountId,
    accountEmail: "acceptance@example.invalid",
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
    z.object({ authorizationUrl: z.string().url() }),
  );
  const reconnectState = new URL(
    reconnectStartBody.authorizationUrl,
  ).searchParams.get("state");
  state.accountId = "google-account-2";
  const reconnectCallback = await handleGoogleDriveArchiveOAuthCallback(
    new Request(CALLBACK + "?code=synthetic-code&state=" + reconnectState),
  );
  expect(reconnectCallback.status).toBe(303);
  expect(reconnectCallback.headers.get("location")).toBe(
    "/settings?googleDriveArchive=pending-snapshots",
  );

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

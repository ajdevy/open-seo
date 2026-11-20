import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { eq, like } from "drizzle-orm";
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
import { googleDriveArchiveConnections, verification } from "@/db/schema";
import { callbackProbeAwareFetch } from "./googleDriveArchiveCallbackTestUtils";
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
  state.resetIdentity();
  state.accountId = "google-account-1";
  Object.keys(state.env).forEach((key) => delete state.env[key]);
  setSyntheticConfig();
  vi.stubGlobal("fetch", callbackProbeAwareFetch());
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
    z.object({
      authorizationUrl: z.string().url(),
      browserBinding: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
    }),
  );
  const url = new URL(body.authorizationUrl);
  const stateToken = url.searchParams.get("state");
  const challenge = url.searchParams.get("code_challenge");
  expect(stateToken).toMatch(/^[A-Za-z0-9_-]{40,64}$/u);
  expect(url.searchParams.get("scope")?.split(" ")).toEqual([DRIVE_SCOPE]);
  expect(url.searchParams.get("include_granted_scopes")).toBe("false");
  expect(url.searchParams.get("redirect_uri")).toBe(CALLBACK);
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  expect(url.searchParams.has("client_secret")).toBe(false);
  const [storedState] = await db
    .select()
    .from(verification)
    .where(like(verification.identifier, "google-drive-archive:%"));
  expect(storedState?.identifier).toBe(`google-drive-archive:${stateToken}`);
  expect(storedState?.value).not.toContain(body.browserBinding);
  const storedValue: unknown = JSON.parse(storedState?.value ?? "{}");
  expect(
    z
      .object({
        browserBindingHash: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
      })
      .parse(storedValue).browserBindingHash,
  ).not.toBe(body.browserBinding);

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

it("does not exchange an OAuth code from a browser without the initiating session binding", async () => {
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
  const fetcher = vi.fn(async () =>
    Response.json({
      access_token: "synthetic-google-access-token",
      refresh_token: "synthetic-google-refresh-token",
      expires_in: 3600,
      scope: DRIVE_SCOPE,
      id_token: "synthetic-id-token",
    }),
  );
  vi.stubGlobal("fetch", callbackProbeAwareFetch(fetcher));

  const response = requireResponse(
    await handleGoogleDriveArchiveRequest(
      new Request(ORIGIN + "/api/google-drive/archive/oauth/complete", {
        method: "POST",
        headers: sameOriginHeaders(),
        body: JSON.stringify({
          state: stateToken,
          browserBinding: "A".repeat(43),
          code: "synthetic-code",
          authorizationDenied: false,
        }),
      }),
    ),
  );

  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: "oauth_browser_mismatch" });
  expect(fetcher).not.toHaveBeenCalled();
  expect(
    await db
      .select()
      .from(googleDriveArchiveConnections)
      .where(eq(googleDriveArchiveConnections.organizationId, "organization")),
  ).toHaveLength(0);
});

it("requires the initiating user and current admin role when completing OAuth", async () => {
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
  state.setRole("member");
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", callbackProbeAwareFetch(fetcher));

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

  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: "admin_required" });
  expect(fetcher).not.toHaveBeenCalled();
});

it("does not attach a Google account when another user completes the state", async () => {
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
  state.setIdentity({ userId: "another-owner" });
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", callbackProbeAwareFetch(fetcher));

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

  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: "admin_required" });
  expect(fetcher).not.toHaveBeenCalled();
});

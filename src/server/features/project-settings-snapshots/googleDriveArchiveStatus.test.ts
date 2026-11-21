import { afterEach, beforeEach, expect, it, vi } from "vitest";

const state = await vi.hoisted(async () => {
  const { createAiVisibilityTestDb } =
    await import("@/server/features/ai-visibility/aiVisibilityTestDb");
  return {
    testDb: await createAiVisibilityTestDb(),
    env: {} as Record<string, string>,
    userContext: () => ({
      userId: "open-seo-user-1",
      organizationId: "organization",
      role: "owner" as const,
    }),
  };
});

vi.mock("@/db", () => ({ db: state.testDb.db }));
vi.mock("@/db/runBatch", () => ({ runBatch: state.testDb.runBatch }));
vi.mock("cloudflare:workers", () => ({ env: { DATABASE_PROVIDER: "d1" } }));
vi.mock("@/middleware/ensure-user/resolve", () => ({
  resolveUserContextFromHeaders: async () => state.userContext(),
}));
vi.mock("@/server/lib/runtime-env", () => ({
  getOptionalEnvValue: async (name: string) => state.env[name],
}));

import { db } from "@/db";
import { projectSettingsSnapshotOutbox } from "@/db/schema";
import { handleGoogleDriveArchiveOAuthCallback } from "./googleDriveArchiveOAuthCallback";
import {
  GOOGLE_DRIVE_ARCHIVE_CALLBACK_PROBE_PARAMETER,
  GOOGLE_DRIVE_ARCHIVE_CALLBACK_PROBE_VERSION,
  GOOGLE_DRIVE_ARCHIVE_CALLBACK_PROBE_ACCEPT,
  GOOGLE_DRIVE_ARCHIVE_CALLBACK_READY_HEADER,
  GOOGLE_DRIVE_ARCHIVE_CALLBACK_READY_VALUE,
} from "./googleDriveArchiveCallbackReadiness";
import { callbackProbeAwareFetch } from "./googleDriveArchiveCallbackTestUtils";
import { handleGoogleDriveArchiveRequest } from "./googleDriveArchiveOAuthRoutes";

const ORIGIN = "https://autogeo.flexsentlabs.com";
const CALLBACK = ORIGIN + "/api/google-drive/archive/oauth/callback";

function outboxRow(
  id: string,
  projectId: string,
  revision: number,
  status: "unconfirmed" | "confirmed",
) {
  return {
    id,
    projectId,
    revision,
    idempotencyKey: `key-${id}`,
    algorithm: "AES-256-GCM",
    schemaVersion: 1,
    iv: "synthetic-iv",
    ciphertext: "synthetic-ciphertext",
    archiveFileId: null,
    status,
    createdAt: "2026-11-20T00:00:00.000Z",
    confirmedAt: status === "confirmed" ? "2026-11-20T00:00:01.000Z" : null,
  };
}

beforeEach(async () => {
  Object.assign(state.env, {
    GOOGLE_DRIVE_ARCHIVE_CLIENT_ID:
      "synthetic-client-id.apps.googleusercontent.com",
    GOOGLE_DRIVE_ARCHIVE_CLIENT_SECRET: "synthetic-oauth-client-secret",
    GOOGLE_DRIVE_ARCHIVE_TOKEN_KEY_B64:
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    GOOGLE_DRIVE_ARCHIVE_REDIRECT_URI:
      ORIGIN + "/api/google-drive/archive/oauth/callback",
    GOOGLE_DRIVE_ARCHIVE_PICKER_API_KEY: "synthetic-picker-key",
    GOOGLE_DRIVE_ARCHIVE_PROJECT_NUMBER: "123456789",
  });
  vi.stubGlobal("fetch", callbackProbeAwareFetch());
  await db.delete(projectSettingsSnapshotOutbox);
  await state.testDb.seedProject();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it("shows only this organization’s unconfirmed snapshots in archive status", async () => {
  await state.testDb.client.executeMultiple(`
    INSERT INTO organization (id, name, slug, created_at)
      VALUES ('other-organization', 'Other Organization', 'other-organization', 0);
    INSERT INTO projects (id, organization_id, name, domain)
      VALUES ('other-project', 'other-organization', 'Other', 'other.example');
  `);
  await db
    .insert(projectSettingsSnapshotOutbox)
    .values([
      outboxRow("pending-current-org", "project", 1, "unconfirmed"),
      outboxRow("confirmed-current-org", "project", 2, "confirmed"),
      outboxRow("pending-other-org", "other-project", 1, "unconfirmed"),
    ]);

  const response = await handleGoogleDriveArchiveRequest(
    new Request(ORIGIN + "/api/google-drive/archive/status", {
      method: "GET",
      headers: {
        origin: ORIGIN,
        "sec-fetch-site": "same-origin",
      },
    }),
  );

  expect(response?.status).toBe(200);
  await expect(response?.json()).resolves.toMatchObject({
    configured: true,
    connected: false,
    unconfirmedSnapshots: 1,
  });
});

it("keeps OAuth unavailable until the configured callback route answers its readiness probe", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 404 })),
  );

  const statusResponse = await handleGoogleDriveArchiveRequest(
    new Request(ORIGIN + "/api/google-drive/archive/status", {
      method: "GET",
      headers: {
        origin: ORIGIN,
        "sec-fetch-site": "same-origin",
      },
    }),
  );
  expect(statusResponse?.status).toBe(200);
  await expect(statusResponse?.json()).resolves.toMatchObject({
    callbackReady: false,
    pickerReady: true,
  });

  const startResponse = await handleGoogleDriveArchiveRequest(
    new Request(ORIGIN + "/api/google-drive/archive/oauth/start", {
      method: "POST",
      headers: {
        origin: ORIGIN,
        "sec-fetch-site": "same-origin",
      },
    }),
  );
  expect(startResponse?.status).toBe(503);
  await expect(startResponse?.json()).resolves.toEqual({
    error: "google_drive_callback_unavailable",
  });

  const pickerResponse = await handleGoogleDriveArchiveRequest(
    new Request(ORIGIN + "/api/google-drive/archive/picker-token", {
      method: "POST",
      headers: {
        origin: ORIGIN,
        "sec-fetch-site": "same-origin",
      },
    }),
  );
  expect(pickerResponse?.status).toBe(503);
  await expect(pickerResponse?.json()).resolves.toEqual({
    error: "google_drive_callback_unavailable",
  });

  const folderResponse = await handleGoogleDriveArchiveRequest(
    new Request(ORIGIN + "/api/google-drive/archive/folder", {
      method: "PUT",
      headers: {
        origin: ORIGIN,
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
      },
      body: JSON.stringify({ id: "folder-id" }),
    }),
  );
  expect(folderResponse?.status).toBe(503);
  await expect(folderResponse?.json()).resolves.toEqual({
    error: "google_drive_callback_unavailable",
  });
});

it("confirms only the configured callback route through a side-effect-free readiness probe", async () => {
  const response = await handleGoogleDriveArchiveOAuthCallback(
    new Request(
      CALLBACK +
        "?" +
        GOOGLE_DRIVE_ARCHIVE_CALLBACK_PROBE_PARAMETER +
        "=" +
        GOOGLE_DRIVE_ARCHIVE_CALLBACK_PROBE_VERSION,
    ),
  );

  expect(response.status).toBe(204);
  expect(response.headers.get(GOOGLE_DRIVE_ARCHIVE_CALLBACK_READY_HEADER)).toBe(
    GOOGLE_DRIVE_ARCHIVE_CALLBACK_READY_VALUE,
  );

  const wrongOrigin = await handleGoogleDriveArchiveOAuthCallback(
    new Request(
      "https://wrong.example.com/api/google-drive/archive/oauth/callback?" +
        GOOGLE_DRIVE_ARCHIVE_CALLBACK_PROBE_PARAMETER +
        "=" +
        GOOGLE_DRIVE_ARCHIVE_CALLBACK_PROBE_VERSION,
    ),
  );
  expect(wrongOrigin.status).toBe(404);

  const wrongOriginAcceptProbe = await handleGoogleDriveArchiveOAuthCallback(
    new Request(
      "https://wrong.example.com/api/google-drive/archive/oauth/callback",
      { headers: { Accept: GOOGLE_DRIVE_ARCHIVE_CALLBACK_PROBE_ACCEPT } },
    ),
  );
  expect(wrongOriginAcceptProbe.status).toBe(404);
});

it("confirms callback readiness before OAuth client credentials are configured", async () => {
  for (const name of [
    "GOOGLE_DRIVE_ARCHIVE_CLIENT_ID",
    "GOOGLE_DRIVE_ARCHIVE_CLIENT_SECRET",
    "GOOGLE_DRIVE_ARCHIVE_TOKEN_KEY_B64",
    "GOOGLE_DRIVE_ARCHIVE_PICKER_API_KEY",
    "GOOGLE_DRIVE_ARCHIVE_PROJECT_NUMBER",
  ]) {
    delete state.env[name];
  }

  const response = await handleGoogleDriveArchiveOAuthCallback(
    new Request(CALLBACK, {
      headers: { Accept: GOOGLE_DRIVE_ARCHIVE_CALLBACK_PROBE_ACCEPT },
    }),
  );

  expect(response.status).toBe(204);
  expect(response.headers.get(GOOGLE_DRIVE_ARCHIVE_CALLBACK_READY_HEADER)).toBe(
    GOOGLE_DRIVE_ARCHIVE_CALLBACK_READY_VALUE,
  );
});

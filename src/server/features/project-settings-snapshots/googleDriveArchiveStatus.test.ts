import { beforeEach, expect, it, vi } from "vitest";

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
import { handleGoogleDriveArchiveRequest } from "./googleDriveArchiveOAuthRoutes";

const ORIGIN = "https://autogeo.flexsentlabs.com";

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
  await db.delete(projectSettingsSnapshotOutbox);
  await state.testDb.seedProject();
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

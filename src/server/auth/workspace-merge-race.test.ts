import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type * as WorkspaceMergeModule from "./workspace-merge";

const mockEnv = vi.hoisted(
  () =>
    ({ DATABASE_PROVIDER: "d1", AUTH_MODE: "cloudflare_access" }) as {
      DATABASE_PROVIDER: string;
      AUTH_MODE?: string;
    },
);
vi.mock("cloudflare:workers", () => ({ env: mockEnv }));

let client: Client;
let testDb: ReturnType<typeof drizzle>;
let WorkspaceMergeService: typeof WorkspaceMergeModule.WorkspaceMergeService;
async function rows(sql: string) {
  return (await client.execute(sql)).rows;
}

beforeAll(async () => {
  client = createClient({ url: "file::memory:" });
  testDb = drizzle(client);
  vi.doMock("@/db", () => ({ db: testDb }));
  vi.doMock("@/db/d1/client", () => ({ d1Db: testDb }));
  vi.doMock("@/db/pg/client", () => ({ pgDb: null }));
  vi.doMock("@/server/lib/runtime-env", () => ({
    getOptionalEnvValue: async (name: string) =>
      name === "AUTOGEO_QUEUE_MASTER_KEY_B64"
        ? btoa("k".repeat(32))
        : undefined,
  }));
  await client.executeMultiple(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE organization (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT
    );
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      domain TEXT,
      location_code INTEGER NOT NULL DEFAULT 2840,
      language_code TEXT NOT NULL DEFAULT 'en',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      archived_at TEXT,
      ai_research_keywords TEXT,
      indexnow_key TEXT
    );
    CREATE UNIQUE INDEX projects_one_default_per_organization_idx
      ON projects (organization_id)
      WHERE name = 'Default' AND domain IS NULL AND archived_at IS NULL;
    CREATE TABLE ai_trackers (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      enabled INTEGER NOT NULL DEFAULT 0,
      chatgpt INTEGER NOT NULL DEFAULT 1,
      gemini INTEGER NOT NULL DEFAULT 0,
      claude INTEGER NOT NULL DEFAULT 0,
      perplexity INTEGER NOT NULL DEFAULT 0,
      google_ai_overview INTEGER NOT NULL DEFAULT 0,
      location_code INTEGER NOT NULL DEFAULT 2840,
      language_code TEXT NOT NULL DEFAULT 'en',
      schedule_interval TEXT NOT NULL DEFAULT 'weekly',
      schedule_weekday INTEGER,
      schedule_hour INTEGER,
      schedule_minute INTEGER,
      schedule_time_zone TEXT,
      pending_scheduled_run_id TEXT,
      next_check_at TEXT,
      last_skip_reason TEXT,
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX ai_trackers_project_idx ON ai_trackers(project_id);
    CREATE TABLE ai_prompts (
      id TEXT PRIMARY KEY,
      tracker_id TEXT NOT NULL REFERENCES ai_trackers(id) ON DELETE CASCADE,
      topic TEXT NOT NULL,
      text TEXT NOT NULL,
      paused INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE project_context_sections (project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, key TEXT NOT NULL, title TEXT, content TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL, PRIMARY KEY (project_id, key));
    CREATE TABLE project_competitors (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, domain TEXT NOT NULL, name TEXT, notes TEXT, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL, UNIQUE (project_id, domain));
    CREATE TABLE project_key_pages (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, url TEXT NOT NULL, role TEXT NOT NULL, topic TEXT, notes TEXT, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL, UNIQUE (project_id, url));
    CREATE TABLE project_settings_snapshot_revisions (
      project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE google_drive_archive_connections (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      google_account_id TEXT NOT NULL,
      access_token_ciphertext TEXT NOT NULL,
      refresh_token_ciphertext TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE project_settings_snapshot_outbox (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      algorithm TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      iv TEXT NOT NULL,
      ciphertext TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      confirmed_at TEXT,
      archive_file_id TEXT,
      UNIQUE(project_id, revision)
    );
    CREATE TABLE user_onboarding_answers (
      user_id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE
    );
    CREATE TABLE organization_activation_state (
      organization_id TEXT PRIMARY KEY REFERENCES organization(id) ON DELETE CASCADE,
      first_mcp_authorized_at TEXT,
      first_mcp_tool_call_at TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE gsc_connections (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
      site_url TEXT NOT NULL,
      connected_by_user_id TEXT NOT NULL
    );
    CREATE TABLE ga4_connections (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE
    );
  `);
  ({ WorkspaceMergeService } = await import("./workspace-merge"));
});

afterAll(() => client.close());
beforeEach(async () => {
  await client.executeMultiple(`
    DELETE FROM projects;
    DELETE FROM user_onboarding_answers;
    DELETE FROM organization_activation_state;
    DELETE FROM gsc_connections;
    DELETE FROM ga4_connections;
    DELETE FROM organization;
    INSERT INTO organization (id, name, slug) VALUES
      ('shared-workspace', 'Shared workspace', 'shared-workspace'),
      ('delegated-u1', 'ben workspace', 'delegated-ben-1'),
      ('delegated-u2', 'sam workspace', 'delegated-sam-2'),
      ('org_hosted', 'Hosted org', 'hosted');
    INSERT INTO projects (id, organization_id, name, domain, archived_at) VALUES
      ('p-shared', 'shared-workspace', 'Default', NULL, NULL),
      ('p1-default', 'delegated-u1', 'Default', NULL, NULL),
      ('p1-acme', 'delegated-u1', 'Acme', 'acme.com', NULL),
      ('p2-default', 'delegated-u2', 'Default', NULL, NULL),
      ('p-hosted', 'org_hosted', 'Default', NULL, NULL);
  `);
});

it("snapshots a project created after selection before deleting its legacy workspace", async () => {
  const originalBatch = client.batch.bind(client);
  let inserted = false;
  const batchSpy = vi
    .spyOn(client, "batch")
    .mockImplementation(async (statements, mode) => {
      if (!inserted) {
        inserted = true;
        await client.execute(
          `INSERT INTO projects (id, organization_id, name, domain, archived_at) VALUES ('p-late', 'delegated-u1', 'Created during merge', 'late.example', NULL)`,
        );
      }
      return originalBatch(statements, mode);
    });
  try {
    await expect(
      WorkspaceMergeService.mergeLegacyWorkspaces(),
    ).resolves.toEqual({ mergedWorkspaces: 2 });
  } finally {
    batchSpy.mockRestore();
  }
  expect(await rows("SELECT id FROM organization ORDER BY id")).toEqual([
    expect.objectContaining({ id: "org_hosted" }),
    expect.objectContaining({ id: "shared-workspace" }),
  ]);
  expect(
    await rows("SELECT id, organization_id FROM projects WHERE id = 'p-late'"),
  ).toEqual([
    expect.objectContaining({
      id: "p-late",
      organization_id: "shared-workspace",
    }),
  ]);
  expect(
    await rows(
      "SELECT project_id, revision FROM project_settings_snapshot_outbox WHERE project_id = 'p-late'",
    ),
  ).toEqual([expect.objectContaining({ project_id: "p-late", revision: 1 })]);
});

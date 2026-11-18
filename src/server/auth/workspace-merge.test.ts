import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type * as WorkspaceMergeModule from "./workspace-merge";
import type { decryptProjectSettingsSnapshot as DecryptProjectSettingsSnapshot } from "@/server/features/project-settings-snapshots/snapshotCrypto";

// Real in-memory SQLite so the repoint-before-delete ordering, the Default
// rename against the partial unique index, and the org-delete cascades run
// against actual SQL — the parts a mocked db can't see.

const mockEnv = vi.hoisted(
  () =>
    ({ DATABASE_PROVIDER: "d1" }) as {
      DATABASE_PROVIDER: string;
      AUTH_MODE?: string;
    },
);

vi.mock("cloudflare:workers", () => ({ env: mockEnv }));

let client: Client;
let testDb: ReturnType<typeof drizzle>;
let WorkspaceMergeService: typeof WorkspaceMergeModule.WorkspaceMergeService;
let decryptProjectSettingsSnapshot: typeof DecryptProjectSettingsSnapshot;

async function rows(sql: string) {
  return (await client.execute(sql)).rows;
}

beforeAll(async () => {
  client = createClient({ url: "file::memory:" });
  testDb = drizzle(client);
  // testDb only exists at runtime, so the module under test must load after
  // these mocks — the one sanctioned use of doMock + dynamic import.
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
      schedule_weekday INTEGER, schedule_hour INTEGER, schedule_minute INTEGER, schedule_time_zone TEXT, pending_scheduled_run_id TEXT,
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
    CREATE TABLE google_drive_archive_connections (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL UNIQUE REFERENCES organization(id) ON DELETE CASCADE, google_account_id TEXT NOT NULL, access_token_ciphertext TEXT NOT NULL, refresh_token_ciphertext TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  `);

  ({ WorkspaceMergeService } = await import("./workspace-merge"));
  ({ decryptProjectSettingsSnapshot } =
    await import("@/server/features/project-settings-snapshots/snapshotCrypto"));
});

afterAll(() => {
  client.close();
});

beforeEach(async () => {
  mockEnv.AUTH_MODE = "cloudflare_access";
  await client.executeMultiple(`
    DROP TRIGGER IF EXISTS reject_snapshot_outbox;
    DELETE FROM projects;
    DELETE FROM user_onboarding_answers;
    DELETE FROM organization_activation_state;
    DELETE FROM gsc_connections;
    DELETE FROM ga4_connections;
    DELETE FROM google_drive_archive_connections;
    DELETE FROM organization;
  `);
});

async function seedLegacyWorkspaces() {
  await client.executeMultiple(`
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
    INSERT INTO ai_trackers (
      id, project_id, enabled, chatgpt, gemini, claude, perplexity,
      google_ai_overview, location_code, language_code, schedule_interval,
      created_at
    ) VALUES (
      'tracker-acme', 'p1-acme', 1, 1, 0, 0, 0, 0, 2840, 'en', 'weekly',
      '2026-01-01 00:00:00'
    );
    INSERT INTO ai_prompts (
      id, tracker_id, topic, text, paused, archived, created_at
    ) VALUES (
      'question-acme-1', 'tracker-acme', 'rank tracking',
      'Which exact stored question should be restored?', 1, 0,
      '2026-01-02 00:00:00'
    );
    INSERT INTO project_context_sections (project_id, key, title, content, updated_at, updated_by) VALUES ('p1-acme', 'business_overview', NULL, 'Acme overview', '2026-01-03T00:00:00Z', 'user'), ('p1-acme', 'custom:launch-plan', 'Launch plan', 'Ship the new site', '2026-01-04T00:00:00Z', 'sam');
    INSERT INTO project_competitors (id, project_id, domain, name, notes, updated_at, updated_by) VALUES ('competitor-acme', 'p1-acme', 'rival.example', 'Rival', 'Pricing-led', '2026-01-05T00:00:00Z', 'user');
    INSERT INTO project_key_pages (id, project_id, url, role, topic, notes, updated_at, updated_by) VALUES ('key-page-acme', 'p1-acme', 'https://acme.example/pricing', 'money', 'Pricing', 'Main offer', '2026-01-06T00:00:00Z', 'user');
    INSERT INTO user_onboarding_answers (user_id, organization_id) VALUES
      ('u1', 'delegated-u1');
    INSERT INTO organization_activation_state
      (organization_id, first_mcp_authorized_at, first_mcp_tool_call_at) VALUES
      ('delegated-u1', '2026-03-01 09:00:00', '2026-03-02 09:00:00'),
      ('delegated-u2', '2026-01-02 09:00:00', NULL);
    INSERT INTO gsc_connections
      (id, project_id, organization_id, site_url, connected_by_user_id) VALUES
      ('gsc1', 'p1-acme', 'delegated-u1', 'sc-domain:acme.com', 'u1');
  `);
}

describe("WorkspaceMergeService", () => {
  it("folds legacy workspaces into the shared workspace and leaves other orgs alone", async () => {
    await seedLegacyWorkspaces();

    await expect(WorkspaceMergeService.countLegacyWorkspaces()).resolves.toBe(
      2,
    );
    await expect(
      WorkspaceMergeService.mergeLegacyWorkspaces(),
    ).resolves.toEqual({ mergedWorkspaces: 2 });

    expect(
      await rows("SELECT id, organization_id, name FROM projects ORDER BY id"),
    ).toEqual([
      expect.objectContaining({
        id: "p-hosted",
        organization_id: "org_hosted",
      }),
      expect.objectContaining({
        id: "p-shared",
        organization_id: "shared-workspace",
        name: "Default",
      }),
      expect.objectContaining({
        id: "p1-acme",
        organization_id: "shared-workspace",
        name: "Acme",
      }),
      expect.objectContaining({
        id: "p1-default",
        organization_id: "shared-workspace",
        name: "Default (ben)",
      }),
      expect.objectContaining({
        id: "p2-default",
        organization_id: "shared-workspace",
        name: "Default (sam)",
      }),
    ]);

    // Legacy orgs are gone; their activation rows cascaded away after the
    // earliest milestones were folded into the shared row.
    expect(await rows("SELECT id FROM organization ORDER BY id")).toEqual([
      expect.objectContaining({ id: "org_hosted" }),
      expect.objectContaining({ id: "shared-workspace" }),
    ]);
    expect(await rows("SELECT * FROM organization_activation_state")).toEqual([
      expect.objectContaining({
        organization_id: "shared-workspace",
        first_mcp_authorized_at: "2026-01-02 09:00:00",
        first_mcp_tool_call_at: "2026-03-02 09:00:00",
      }),
    ]);
    const snapshots = await rows(
      "SELECT project_id, revision, algorithm, schema_version, iv, ciphertext, status FROM project_settings_snapshot_outbox ORDER BY project_id",
    );
    expect(snapshots).toHaveLength(3);
    expect(snapshots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          project_id: "p1-default",
          revision: 1,
          status: "unconfirmed",
        }),
        expect.objectContaining({
          project_id: "p1-acme",
          revision: 1,
          status: "unconfirmed",
        }),
        expect.objectContaining({
          project_id: "p2-default",
          revision: 1,
          status: "unconfirmed",
        }),
      ]),
    );
    const acmeSnapshotRow = snapshots.find(
      (snapshot) => snapshot.project_id === "p1-acme",
    );
    if (!acmeSnapshotRow) {
      throw new Error("Expected the Acme project snapshot row to be present.");
    }
    if (
      typeof acmeSnapshotRow.revision !== "number" ||
      typeof acmeSnapshotRow.algorithm !== "string" ||
      typeof acmeSnapshotRow.schema_version !== "number" ||
      typeof acmeSnapshotRow.iv !== "string" ||
      typeof acmeSnapshotRow.ciphertext !== "string"
    ) {
      throw new Error(
        "Expected the Acme project snapshot row to be decryptable.",
      );
    }
    await expect(
      decryptProjectSettingsSnapshot({
        projectId: "p1-acme",
        revision: acmeSnapshotRow.revision,
        algorithm: acmeSnapshotRow.algorithm,
        schemaVersion: acmeSnapshotRow.schema_version,
        iv: acmeSnapshotRow.iv,
        ciphertext: acmeSnapshotRow.ciphertext,
      }),
    ).resolves.toMatchObject({
      clientId: "shared-workspace",
      projectId: "p1-acme",
      project: { name: "Acme" },
      tracker: { id: "tracker-acme", enabled: true },
      questions: [
        {
          id: "question-acme-1",
          text: "Which exact stored question should be restored?",
          paused: true,
          archived: false,
        },
      ],
      context: {
        sections: [
          { key: "business_overview", title: null, content: "Acme overview" },
          {
            key: "custom:launch-plan",
            title: "Launch plan",
            content: "Ship the new site",
          },
        ],
        competitors: [
          { domain: "rival.example", name: "Rival", notes: "Pricing-led" },
        ],
        keyPages: [
          {
            url: "https://acme.example/pricing",
            role: "money",
            topic: "Pricing",
            notes: "Main offer",
          },
        ],
      },
    });
    expect(
      await rows(
        "SELECT count(*) AS n FROM project_settings_snapshot_revisions",
      ),
    ).toEqual([expect.objectContaining({ n: 3 })]);
    expect(await rows("SELECT organization_id FROM gsc_connections")).toEqual([
      expect.objectContaining({ organization_id: "shared-workspace" }),
    ]);
    expect(
      await rows("SELECT organization_id FROM user_onboarding_answers"),
    ).toEqual([
      expect.objectContaining({ organization_id: "shared-workspace" }),
    ]);
  });

  it("refuses to run outside cloudflare_access mode", async () => {
    await seedLegacyWorkspaces();
    mockEnv.AUTH_MODE = "local_noauth";

    await expect(
      WorkspaceMergeService.mergeLegacyWorkspaces(),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    // Nothing was touched.
    expect(await rows("SELECT count(*) AS n FROM organization")).toEqual([
      expect.objectContaining({ n: 4 }),
    ]);
  });

  it("rolls back the complete merge when an encrypted outbox insert fails", async () => {
    await seedLegacyWorkspaces();
    await client.execute(`
      CREATE TRIGGER reject_snapshot_outbox
      BEFORE INSERT ON project_settings_snapshot_outbox
      BEGIN
        SELECT RAISE(ABORT, 'synthetic outbox failure');
      END;
    `);

    await expect(WorkspaceMergeService.mergeLegacyWorkspaces()).rejects.toThrow(
      "synthetic outbox failure",
    );

    expect(await rows("SELECT id FROM organization ORDER BY id")).toHaveLength(
      4,
    );
    expect(
      await rows(
        "SELECT id, organization_id, name FROM projects WHERE id IN ('p1-default', 'p1-acme', 'p2-default') ORDER BY id",
      ),
    ).toEqual([
      expect.objectContaining({
        id: "p1-acme",
        organization_id: "delegated-u1",
        name: "Acme",
      }),
      expect.objectContaining({
        id: "p1-default",
        organization_id: "delegated-u1",
        name: "Default",
      }),
      expect.objectContaining({
        id: "p2-default",
        organization_id: "delegated-u2",
        name: "Default",
      }),
    ]);
    expect(
      await rows(
        "SELECT count(*) AS n FROM project_settings_snapshot_revisions",
      ),
    ).toEqual([expect.objectContaining({ n: 0 })]);
    expect(
      await rows("SELECT count(*) AS n FROM project_settings_snapshot_outbox"),
    ).toEqual([expect.objectContaining({ n: 0 })]);
  });
});

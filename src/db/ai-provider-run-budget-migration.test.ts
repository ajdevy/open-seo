import { readFileSync, readdirSync } from "node:fs";
import { createClient } from "@libsql/client";
import { sort } from "remeda";
import { afterEach, describe, expect, it } from "vitest";

const sqliteClient = createClient({ url: "file::memory:" });

afterEach(() => sqliteClient.close());

async function applySqliteMigration(file: string) {
  await sqliteClient.executeMultiple(
    readFileSync(`drizzle/sqlite/${file}`, "utf8").replaceAll(
      "--> statement-breakpoint",
      "",
    ),
  );
}

describe("legacy provider budget migration", () => {
  it("backfills active runs as idempotent unknown holds without replacing reservations", async () => {
    const migrations = sort(
      readdirSync("drizzle/sqlite").filter((file) => file.endsWith(".sql")),
      (a, b) => a.localeCompare(b),
    );
    for (const file of migrations) {
      if (file === "0070_amused_la_nuit.sql") break;
      await applySqliteMigration(file);
    }

    await sqliteClient.executeMultiple(`
      INSERT INTO organization (id, name, slug, created_at)
        VALUES ('legacy-org', 'Legacy Org', 'legacy-org', 0);
      INSERT INTO projects (id, organization_id, name)
        VALUES
          ('queued-project', 'legacy-org', 'Queued'),
          ('running-project', 'legacy-org', 'Running'),
          ('reserved-project', 'legacy-org', 'Reserved'),
          ('terminal-project', 'legacy-org', 'Terminal');
      INSERT INTO ai_trackers (id, project_id, created_at)
        VALUES
          ('queued-tracker', 'queued-project', '2026-11-01T00:00:00.000Z'),
          ('running-tracker', 'running-project', '2026-11-01T00:00:00.000Z'),
          ('reserved-tracker', 'reserved-project', '2026-11-01T00:00:00.000Z'),
          ('terminal-tracker', 'terminal-project', '2026-11-01T00:00:00.000Z');
      INSERT INTO ai_runs (
        id, tracker_id, project_id, trigger, status, location_code,
        language_code, created_at
      ) VALUES
        ('legacy-queued', 'queued-tracker', 'queued-project', 'scheduled', 'queued', 2840, 'en', '2026-11-10T00:00:00.000Z'),
        ('legacy-running', 'running-tracker', 'running-project', 'scheduled', 'running', 2840, 'en', '2026-11-11T00:00:00.000Z'),
        ('already-reserved', 'reserved-tracker', 'reserved-project', 'scheduled', 'running', 2840, 'en', '2026-11-11T00:00:00.000Z'),
        ('terminal-completed', 'terminal-tracker', 'terminal-project', 'manual', 'completed', 2840, 'en', '2026-11-10T00:00:00.000Z'),
        ('terminal-partial', 'terminal-tracker', 'terminal-project', 'manual', 'partial', 2840, 'en', '2026-11-10T00:00:00.000Z'),
        ('terminal-failed', 'terminal-tracker', 'terminal-project', 'manual', 'failed', 2840, 'en', '2026-11-10T00:00:00.000Z');
    `);

    await applySqliteMigration("0070_amused_la_nuit.sql");
    await sqliteClient.execute({
      sql: `
        INSERT INTO ai_provider_run_reservations (
          id, project_id, run_id, reserved_usd_micros, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `,
      args: [
        "reservation-already-reserved",
        "reserved-project",
        "already-reserved",
        2_000_000,
        "reserved",
        "2026-11-11T00:00:00.000Z",
      ],
    });

    await applySqliteMigration("0071_legacy_provider_budget_holds.sql");
    await applySqliteMigration("0071_legacy_provider_budget_holds.sql");

    const reservations = await sqliteClient.execute(`
      SELECT id, project_id, run_id, reserved_usd_micros, status, created_at
      FROM ai_provider_run_reservations
      ORDER BY run_id
    `);
    expect(reservations.rows).toEqual([
      {
        id: "reservation-already-reserved",
        project_id: "reserved-project",
        run_id: "already-reserved",
        reserved_usd_micros: 2_000_000,
        status: "reserved",
        created_at: "2026-11-11T00:00:00.000Z",
      },
      {
        id: "legacy-active-run:legacy-queued",
        project_id: "queued-project",
        run_id: "legacy-queued",
        reserved_usd_micros: 8_000_000,
        status: "unknown",
        created_at: "2026-11-10T00:00:00.000Z",
      },
      {
        id: "legacy-active-run:legacy-running",
        project_id: "running-project",
        run_id: "legacy-running",
        reserved_usd_micros: 8_000_000,
        status: "unknown",
        created_at: "2026-11-11T00:00:00.000Z",
      },
    ]);

    const unreservedActiveRuns = await sqliteClient.execute(`
      SELECT COUNT(*) AS count
      FROM ai_runs
      LEFT JOIN ai_provider_run_reservations
        ON ai_provider_run_reservations.run_id = ai_runs.id
      WHERE ai_runs.status IN ('queued', 'running')
        AND ai_provider_run_reservations.run_id IS NULL
    `);
    expect(unreservedActiveRuns.rows[0]?.count).toBe(0);
  });

  it("keeps the PostgreSQL backfill aligned with the SQLite migration", () => {
    const sqliteSql = readFileSync(
      "drizzle/sqlite/0071_legacy_provider_budget_holds.sql",
      "utf8",
    ).replaceAll(/[\s`"]+/g, " ");
    const postgresSql = readFileSync(
      "drizzle/pg/0049_legacy_provider_budget_holds.sql",
      "utf8",
    ).replaceAll(/[\s`"]+/g, " ");

    for (const sql of [sqliteSql, postgresSql]) {
      expect(sql).toContain("8000000");
      expect(sql).toContain("status IN ('queued', 'running')");
      expect(sql).toContain("'unknown'");
      expect(sql).toContain("NOT EXISTS");
      expect(sql).toMatch(/run_id\s*=\s*ai_runs\s*\.\s*id/);
    }
  });
});

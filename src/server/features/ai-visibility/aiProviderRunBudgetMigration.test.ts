import { readFileSync } from "node:fs";
import { createClient } from "@libsql/client";
import { describe, expect, it } from "vitest";

describe("provider run budget migration", () => {
  it("copies unresolved reservations and removes project/run cascades", async () => {
    const client = createClient({ url: "file::memory:" });
    try {
      await client.execute("PRAGMA foreign_keys = ON");
      await client.executeMultiple(`
        CREATE TABLE projects (id TEXT PRIMARY KEY NOT NULL);
        CREATE TABLE ai_runs (
          id TEXT PRIMARY KEY NOT NULL,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE
        );
        CREATE TABLE ai_provider_run_reservations (
          id TEXT PRIMARY KEY NOT NULL,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          run_id TEXT NOT NULL REFERENCES ai_runs(id) ON DELETE CASCADE,
          reserved_usd_micros INTEGER NOT NULL,
          accounted_usd_micros INTEGER,
          status TEXT DEFAULT 'reserved' NOT NULL,
          created_at TEXT NOT NULL,
          settled_at TEXT,
          reconciliation_reference TEXT,
          reconciled_at TEXT
        );
        CREATE UNIQUE INDEX ai_provider_run_reservations_run_idx
          ON ai_provider_run_reservations(run_id);
        CREATE UNIQUE INDEX ai_provider_run_reservations_project_active_idx
          ON ai_provider_run_reservations(project_id)
          WHERE status = 'reserved';
        CREATE INDEX ai_provider_run_reservations_project_created_idx
          ON ai_provider_run_reservations(project_id, created_at);
        INSERT INTO projects (id) VALUES ('project');
        INSERT INTO ai_runs (id, project_id) VALUES ('run', 'project');
        INSERT INTO ai_provider_run_reservations (
          id, project_id, run_id, reserved_usd_micros, accounted_usd_micros,
          status, created_at
        ) VALUES (
          'unknown-hold', 'project', 'run', 2000000, NULL,
          'unknown', '2026-11-20T00:00:00.000Z'
        );
      `);

      const migration = readFileSync(
        "drizzle/sqlite/0072_slim_iron_lad.sql",
        "utf8",
      ).replaceAll("--> statement-breakpoint", "");
      await client.executeMultiple(migration);

      const foreignKeys = await client.execute(
        "PRAGMA foreign_key_list('ai_provider_run_reservations')",
      );
      expect(foreignKeys.rows).toHaveLength(0);

      await client.execute("DELETE FROM ai_runs WHERE id = ?", ["run"]);
      await client.execute("DELETE FROM projects WHERE id = ?", ["project"]);
      const result = await client.execute(
        "SELECT status, reserved_usd_micros FROM ai_provider_run_reservations WHERE id = ?",
        ["unknown-hold"],
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.status).toBe("unknown");
      expect(result.rows[0]?.reserved_usd_micros).toBe(2_000_000);
    } finally {
      client.close();
    }
  });
});

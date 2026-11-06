import { readdirSync, readFileSync } from "node:fs";
import { createClient } from "@libsql/client";
import { sort } from "remeda";
import { afterEach, describe, expect, it } from "vitest";

const sqliteClient = createClient({ url: "file::memory:" });

afterEach(async () => {
  sqliteClient.close();
});

describe("native result migrations", () => {
  it("preserves legacy data and adds a nullable finalization token to SQLite results", async () => {
    const migrations = sort(
      readdirSync("drizzle/sqlite").filter((file) => file.endsWith(".sql")),
      (a, b) => a.localeCompare(b),
    );
    const nativeMigration = "0063_ai_native_results.sql";
    for (const file of migrations) {
      if (file === nativeMigration) break;
      await sqliteClient.executeMultiple(
        readFileSync(`drizzle/sqlite/${file}`, "utf8").replaceAll(
          "--> statement-breakpoint",
          "",
        ),
      );
    }

    await sqliteClient.executeMultiple(`
      INSERT INTO organization (id, name, slug, created_at)
        VALUES ('legacy-client', 'Legacy Client', 'legacy-client', 0);
      INSERT INTO projects (id, organization_id, name, domain)
        VALUES ('legacy-project', 'legacy-client', 'Legacy Project', NULL);
      INSERT INTO ai_trackers (id, project_id, created_at)
        VALUES ('legacy-tracker', 'legacy-project', '2026-09-01T00:00:00.000Z');
      INSERT INTO ai_prompts (id, tracker_id, topic, text, created_at)
        VALUES ('legacy-question', 'legacy-tracker', 'General', 'Original question?', '2026-09-01T00:00:00.000Z');
      INSERT INTO ai_runs (id, tracker_id, project_id, trigger, status, location_code, language_code, created_at)
        VALUES ('legacy-run', 'legacy-tracker', 'legacy-project', 'baseline', 'completed', 2840, 'en', '2026-09-01T00:00:00.000Z');
      INSERT INTO ai_observations (id, run_id, prompt_id, engine, branded, status, collected_at, answer_markdown)
        VALUES ('legacy-answer', 'legacy-run', 'legacy-question', 'chatgpt', 0, 'completed', '2026-09-01T00:00:00.000Z', 'Saved before native results.');
      INSERT INTO ai_sources (id, observation_id, url, domain, title, position)
        VALUES ('legacy-source', 'legacy-answer', 'https://legacy.example/page', 'legacy.example', 'Legacy source', 1);
    `);

    await sqliteClient.executeMultiple(
      readFileSync(`drizzle/sqlite/${nativeMigration}`, "utf8").replaceAll(
        "--> statement-breakpoint",
        "",
      ),
    );

    await sqliteClient.execute(`
      INSERT INTO ai_native_results (
        id, schema_version, client_id, project_id, run_id, question_id,
        question_version, question_snapshot, requested_model, route,
        result_status, answer, search_status, eligible_for_visibility,
        collected_at
      ) VALUES (
        'native-answer', 1, 'legacy-client', 'legacy-project', 'legacy-run',
        'legacy-question', 1, 'Original question?', 'model-a', 'codex_cli',
        'completed', 'Saved native answer.', 'completed', 1,
        '2026-09-01T00:00:00.000Z'
      )
    `);

    await sqliteClient.executeMultiple(
      readFileSync("drizzle/sqlite/0064_clumsy_tigra.sql", "utf8"),
    );

    const oldObservation = await sqliteClient.execute(
      "SELECT id, prompt_id, engine, status, answer_markdown FROM ai_observations WHERE id = 'legacy-answer'",
    );
    const oldSource = await sqliteClient.execute(
      "SELECT id, observation_id, url, position FROM ai_sources WHERE id = 'legacy-source'",
    );
    const nativeRows = await sqliteClient.execute(
      "SELECT id, answer, finalization_token FROM ai_native_results",
    );

    expect(oldObservation.rows).toEqual([
      {
        id: "legacy-answer",
        prompt_id: "legacy-question",
        engine: "chatgpt",
        status: "completed",
        answer_markdown: "Saved before native results.",
      },
    ]);
    expect(oldSource.rows).toEqual([
      {
        id: "legacy-source",
        observation_id: "legacy-answer",
        url: "https://legacy.example/page",
        position: 1,
      },
    ]);
    expect(nativeRows.rows).toEqual([
      {
        id: "native-answer",
        answer: "Saved native answer.",
        finalization_token: null,
      },
    ]);
  });

  it.each([
    ["SQLite", "drizzle/sqlite/0063_ai_native_results.sql"],
    ["PostgreSQL", "drizzle/pg/0041_ai_native_results.sql"],
  ])("adds only new tables and indexes in the %s migration", (_, file) => {
    const sql = readFileSync(file, "utf8");
    expect(sql).toContain("ai_native_results");
    expect(sql).toContain("ai_native_sources");
    expect(sql).toContain("ai_native_search_sources");
    expect(sql).toContain("ai_native_search_evidence");
    expect(sql).not.toMatch(
      /(?:^|;--> statement-breakpoint)\s*(?:UPDATE|INSERT INTO|DELETE FROM)\b/i,
    );
    expect(sql).not.toMatch(/ALTER TABLE\s+"?ai_observations"?/i);
    expect(sql).not.toMatch(/ALTER TABLE\s+"?ai_sources"?/i);
    expect(sql).not.toMatch(/ALTER TABLE\s+"?ai_prompts"?/i);
    expect(sql).not.toMatch(/DEFAULT .*search_status/i);
  });

  it.each([
    ["SQLite", "drizzle/sqlite/0064_clumsy_tigra.sql"],
    ["PostgreSQL", "drizzle/pg/0042_parched_maggott.sql"],
  ])("adds a nullable finalization token to %s native results", (_, file) => {
    const sql = readFileSync(file, "utf8");
    expect(sql).toMatch(/ALTER TABLE [`"]?ai_native_results[`"]?/i);
    expect(sql).toMatch(/finalization_token[`"]?\s+(?:text|TEXT)/i);
    expect(sql).not.toMatch(
      /(?:^|;--> statement-breakpoint)\s*(?:UPDATE|INSERT INTO|DELETE FROM)\b/i,
    );
  });
});

import { readFileSync } from "node:fs";
import type { createClient } from "@libsql/client";
import type { ProjectSettingsRows } from "@/server/features/project-settings-snapshots/snapshotRepository";
import type {
  ContextAuthor,
  KeyPageRole,
} from "@/types/schemas/projectContext";

type TestClient = ReturnType<typeof createClient>;

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string")
    throw new Error(`Missing ${field} in test row.`);
  return value;
}

function nullableText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  throw new Error("Expected text or null in test row.");
}

function contextAuthor(value: unknown): ContextAuthor {
  if (value === "user" || value === "sam" || value === "mcp") return value;
  throw new Error("Unexpected context author in test row.");
}

function keyPageRole(value: unknown): KeyPageRole {
  if (
    value === "hub" ||
    value === "spoke" ||
    value === "money" ||
    value === "other"
  )
    return value;
  throw new Error("Unexpected key page role in test row.");
}

export async function setupProjectWebsiteSnapshotDb(client: TestClient) {
  await client.executeMultiple(
    [
      `CREATE TABLE projects (
        id text PRIMARY KEY,
        organization_id text NOT NULL,
        name text NOT NULL,
        domain text,
        location_code integer NOT NULL DEFAULT 2840,
        language_code text NOT NULL DEFAULT 'en',
        created_at text NOT NULL DEFAULT CURRENT_TIMESTAMP,
        archived_at text,
        ai_research_keywords text,
        indexnow_key text
      );`,
      ...readFileSync("drizzle/sqlite/0042_project_memory.sql", "utf8")
        .split("--> statement-breakpoint")
        .filter((sql) => !sql.includes("DROP TABLE")),
    ].join("\n"),
  );

  return async (id: string): Promise<ProjectSettingsRows | null> => {
    const [projectRow] = (
      await client.execute({
        sql: "SELECT * FROM projects WHERE id = ?",
        args: [id],
      })
    ).rows;
    if (!projectRow) return null;

    const [sections, competitors, keyPages] = await Promise.all([
      client.execute({
        sql: "SELECT * FROM project_context_sections WHERE project_id = ? ORDER BY key",
        args: [id],
      }),
      client.execute({
        sql: "SELECT * FROM project_competitors WHERE project_id = ? ORDER BY domain",
        args: [id],
      }),
      client.execute({
        sql: "SELECT * FROM project_key_pages WHERE project_id = ? ORDER BY url",
        args: [id],
      }),
    ]);

    return {
      project: {
        id: requiredText(projectRow.id, "project id"),
        organizationId: requiredText(
          projectRow.organization_id,
          "organization id",
        ),
        name: requiredText(projectRow.name, "project name"),
        domain: nullableText(projectRow.domain),
        locationCode: Number(projectRow.location_code),
        languageCode: requiredText(projectRow.language_code, "language code"),
        createdAt: requiredText(projectRow.created_at, "project createdAt"),
        archivedAt: nullableText(projectRow.archived_at),
        aiResearchKeywords: nullableText(projectRow.ai_research_keywords),
        indexnowKey: nullableText(projectRow.indexnow_key),
      },
      tracker: null,
      questions: [],
      context: {
        sections: sections.rows.map((row) => ({
          projectId: id,
          key: requiredText(row.key, "section key"),
          title: nullableText(row.title),
          content: requiredText(row.content, "section content"),
          updatedAt: requiredText(row.updated_at, "section updatedAt"),
          updatedBy: contextAuthor(row.updated_by),
        })),
        competitors: competitors.rows.map((row) => ({
          id: requiredText(row.id, "competitor id"),
          projectId: id,
          domain: requiredText(row.domain, "competitor domain"),
          name: nullableText(row.name),
          notes: nullableText(row.notes),
          updatedAt: requiredText(row.updated_at, "competitor updatedAt"),
          updatedBy: contextAuthor(row.updated_by),
        })),
        keyPages: keyPages.rows.map((row) => ({
          id: requiredText(row.id, "key page id"),
          projectId: id,
          url: requiredText(row.url, "key page url"),
          role: keyPageRole(row.role),
          topic: nullableText(row.topic),
          notes: nullableText(row.notes),
          updatedAt: requiredText(row.updated_at, "key page updatedAt"),
          updatedBy: contextAuthor(row.updated_by),
        })),
      },
    };
  };
}

import { runBatch } from "@/db/runBatch";
import { ProjectContextRepository } from "@/server/features/project-context/repositories/ProjectContextRepository";
import { resolveContextUpdates } from "@/server/features/project-context/services/contextUpdateOps";
import { ReportTemplateRepository } from "@/server/features/reports/repositories/ReportTemplateRepository";
import { AppError } from "@/server/lib/errors";
import {
  commitProjectSettingsMutation,
  makeProjectSettingsSnapshot,
  readProjectSettingsRows,
  type ProjectSettingsSnapshotContext,
} from "@/server/features/project-settings-snapshots/snapshotRepository";
import {
  CUSTOM_SECTION_KEY_PREFIX,
  PROJECT_CONTEXT_SECTION_KEYS,
  PROJECT_CONTEXT_SECTION_LABELS,
  type ContextAuthor,
  type KeyPageRole,
  type ProjectContextSectionKey,
  type ProjectContextUpdate,
} from "@/types/schemas/projectContext";
// Project memory: the qualitative context SAM, MCP clients and the settings UI
// share. Reading, writing and rendering it all go through here; the per-op
// caps and normalization live in contextUpdateOps.
const RESEARCH_LOG_RETENTION_DAYS = 90;
const RESEARCH_LOG_LIMIT = 20;
type Tx = Parameters<Parameters<typeof runBatch>[0]>[0];
type ResolvedContextOp = ReturnType<typeof resolveContextUpdates>[number];

type ProjectContext = {
  sections: {
    key: ProjectContextSectionKey;
    content: string;
    updatedAt: string;
    updatedBy: ContextAuthor;
  }[];
  /** Typed sections with nothing stored, so agents know what to fill. */
  missingSections: ProjectContextSectionKey[];
  customSections: {
    slug: string;
    title: string | null;
    content: string;
    updatedAt: string;
    updatedBy: ContextAuthor;
  }[];
  competitors: {
    id: string;
    domain: string;
    name: string | null;
    notes: string | null;
    updatedAt: string;
    updatedBy: ContextAuthor;
  }[];
  keyPages: {
    id: string;
    url: string;
    role: KeyPageRole;
    topic: string | null;
    notes: string | null;
    updatedAt: string;
    updatedBy: ContextAuthor;
  }[];
  researchLog: {
    id: string;
    entryDate: string;
    summary: string;
    createdBy: ContextAuthor;
  }[];
  /**
   * The project's report templates. They belong to the reports feature, but
   * this digest is the one block every skill already reads, so it is where
   * agents discover them.
   */
  reportTemplates: { name: string; description: string }[];
};

export async function getProjectContext(
  projectId: string,
): Promise<ProjectContext> {
  const [sectionRows, competitors, keyPages, researchLog, reportTemplates] =
    await Promise.all([
      ProjectContextRepository.listSections(projectId),
      ProjectContextRepository.listCompetitors(projectId),
      ProjectContextRepository.listKeyPages(projectId),
      ProjectContextRepository.listResearchLog(projectId, RESEARCH_LOG_LIMIT),
      ReportTemplateRepository.listTemplates(projectId),
    ]);

  const stored = new Map(sectionRows.map((row) => [row.key, row]));
  // Typed sections keep their declared order, which is also the order the
  // digest and the settings UI render them in.
  const sections = PROJECT_CONTEXT_SECTION_KEYS.flatMap((key) => {
    const row = stored.get(key);
    return row
      ? [
          {
            key,
            content: row.content,
            updatedAt: row.updatedAt,
            updatedBy: row.updatedBy,
          },
        ]
      : [];
  });

  return {
    sections,
    missingSections: PROJECT_CONTEXT_SECTION_KEYS.filter(
      (key) => !stored.has(key),
    ),
    customSections: sectionRows
      .filter((row) => row.key.startsWith(CUSTOM_SECTION_KEY_PREFIX))
      .map((row) => ({
        slug: row.key.slice(CUSTOM_SECTION_KEY_PREFIX.length),
        title: row.title,
        content: row.content,
        updatedAt: row.updatedAt,
        updatedBy: row.updatedBy,
      })),
    competitors,
    keyPages,
    researchLog: researchLog.map((row) => ({
      id: row.id,
      entryDate: row.entryDate,
      summary: row.summary,
      createdBy: row.createdBy,
    })),
    reportTemplates: reportTemplates.map((template) => ({
      name: template.name,
      description: template.description,
    })),
  };
}

function dayStamp(offsetDays = 0): string {
  const date = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
  return date.toISOString().slice(0, 10);
}

function projectedSnapshotContext(
  context: ProjectSettingsSnapshotContext,
  operations: ResolvedContextOp[],
): ProjectSettingsSnapshotContext {
  const sections = new Map(context.sections.map((row) => [row.key, row]));
  const competitors = new Map(
    context.competitors.map((row) => [row.domain, row]),
  );
  const keyPages = new Map(context.keyPages.map((row) => [row.url, row]));

  for (const operation of operations) {
    switch (operation.kind) {
      case "upsertSection": {
        const previous = sections.get(operation.key);
        sections.set(operation.key, {
          key: operation.key,
          title: operation.title ?? previous?.title ?? null,
          content: operation.content,
        });
        break;
      }
      case "deleteSection":
        sections.delete(operation.key);
        break;
      case "upsertCompetitors":
        for (const row of operation.rows) {
          const previous = competitors.get(row.domain);
          competitors.set(row.domain, {
            domain: row.domain,
            name: row.name ?? previous?.name ?? null,
            notes: row.notes ?? previous?.notes ?? null,
          });
        }
        break;
      case "deleteCompetitors":
        for (const domain of operation.domains) competitors.delete(domain);
        break;
      case "upsertKeyPages":
        for (const row of operation.rows) {
          const previous = keyPages.get(row.url);
          keyPages.set(row.url, {
            url: row.url,
            role: row.role ?? previous?.role ?? "other",
            topic: row.topic ?? previous?.topic ?? null,
            notes: row.notes ?? previous?.notes ?? null,
          });
        }
        break;
      case "deleteKeyPages":
        for (const url of operation.urls) keyPages.delete(url);
        break;
      case "appendResearchLog":
      case "deleteResearchLog":
        break;
    }
  }

  return {
    sections: [...sections.values()],
    competitors: [...competitors.values()],
    keyPages: [...keyPages.values()],
  };
}

function writeResolvedContextUpdates(
  projectId: string,
  resolved: ResolvedContextOp[],
  updatedBy: ContextAuthor,
  tx: Tx,
) {
  return resolved.flatMap((op): Promise<unknown>[] => {
    switch (op.kind) {
      case "upsertSection":
        return [
          ProjectContextRepository.upsertSection(tx, {
            projectId,
            key: op.key,
            title: op.title,
            content: op.content,
            updatedBy,
          }),
        ];
      case "deleteSection":
        return [ProjectContextRepository.deleteSection(tx, projectId, op.key)];
      case "upsertCompetitors":
        return ProjectContextRepository.upsertCompetitors(
          tx,
          projectId,
          op.rows,
          updatedBy,
        );
      case "deleteCompetitors":
        return ProjectContextRepository.deleteCompetitors(
          tx,
          projectId,
          op.domains,
        );
      case "upsertKeyPages":
        return ProjectContextRepository.upsertKeyPages(
          tx,
          projectId,
          op.rows,
          updatedBy,
        );
      case "deleteKeyPages":
        return ProjectContextRepository.deleteKeyPages(tx, projectId, op.urls);
      case "deleteResearchLog":
        return ProjectContextRepository.deleteResearchLogEntries(
          tx,
          projectId,
          op.ids,
        );
      case "appendResearchLog":
        return [
          ProjectContextRepository.appendResearchLogEntry(tx, {
            projectId,
            entryDate: dayStamp(),
            summary: op.summary,
            createdBy: updatedBy,
          }),
          ProjectContextRepository.pruneResearchLogBefore(
            tx,
            projectId,
            dayStamp(-RESEARCH_LOG_RETENTION_DAYS),
          ),
        ];
    }
  });
}

/**
 * Applies the patch ops in order, then returns the resulting context. The batch
 * is resolved and capped up front, so a call that trips a limit writes nothing
 * at all rather than leaving the project half-updated.
 */
export async function applyContextUpdates(
  projectId: string,
  updates: ProjectContextUpdate[],
  updatedBy: ContextAuthor,
): Promise<ProjectContext> {
  const hasSettingsUpdates = updates.some(
    (update) =>
      !("appendResearchLog" in update) && !("removeResearchLog" in update),
  );

  if (hasSettingsUpdates) {
    await commitProjectSettingsMutation(projectId, async () => {
      const state = await readProjectSettingsRows(projectId);
      if (!state) throw new AppError("NOT_FOUND");

      const resolved = resolveContextUpdates(updates, {
        customKeys: new Set(
          state.context.sections
            .map((row) => row.key)
            .filter((key) => key.startsWith(CUSTOM_SECTION_KEY_PREFIX)),
        ),
        domains: new Set(state.context.competitors.map((row) => row.domain)),
        urls: new Set(state.context.keyPages.map((row) => row.url)),
      });

      return {
        snapshot: makeProjectSettingsSnapshot({
          ...state,
          context: projectedSnapshotContext(state.context, resolved),
        }),
        write: (tx) =>
          writeResolvedContextUpdates(projectId, resolved, updatedBy, tx),
        result: undefined,
      };
    });
  } else {
    const [sectionRows, competitorRows, keyPageRows] = await Promise.all([
      ProjectContextRepository.listSections(projectId),
      ProjectContextRepository.listCompetitors(projectId),
      ProjectContextRepository.listKeyPages(projectId),
    ]);

    const resolved = resolveContextUpdates(updates, {
      customKeys: new Set(
        sectionRows
          .map((row) => row.key)
          .filter((key) => key.startsWith(CUSTOM_SECTION_KEY_PREFIX)),
      ),
      domains: new Set(competitorRows.map((row) => row.domain)),
      urls: new Set(keyPageRows.map((row) => row.url)),
    });

    // Research-log-only writes remain a single atomic batch and don't create a
    // settings snapshot because the log is transient activity history.
    await runBatch((tx) =>
      writeResolvedContextUpdates(projectId, resolved, updatedBy, tx),
    );
  }

  return getProjectContext(projectId);
}

function pushSection(lines: string[], heading: string, body: string[]) {
  lines.push(
    `## ${heading}`,
    "",
    ...(body.length > 0 ? body : ["_Empty_"]),
    "",
  );
}

/**
 * The one markdown digest of a project's memory, rendered for the MCP tool's
 * `text` payload and for SAM's read-only context block. Typed sections are
 * always listed — an empty one shows up as missing, which is the signal agents
 * use to offer setup.
 *
 * The report-templates section is omitted entirely when there are none, so a
 * project with no templates reads exactly as it did before.
 */
export function renderProjectContextMarkdown(context: ProjectContext): string {
  const lines = ["# Project context", ""];

  for (const key of PROJECT_CONTEXT_SECTION_KEYS) {
    const section = context.sections.find((entry) => entry.key === key);
    pushSection(
      lines,
      PROJECT_CONTEXT_SECTION_LABELS[key],
      section ? [section.content] : [],
    );
  }

  for (const custom of context.customSections) {
    pushSection(lines, custom.title ?? custom.slug, [custom.content]);
  }

  pushSection(
    lines,
    "Competitors",
    context.competitors.map((competitor) =>
      [
        `- ${competitor.domain}`,
        competitor.name ? ` — ${competitor.name}` : "",
        competitor.notes ? ` (${competitor.notes})` : "",
      ].join(""),
    ),
  );

  pushSection(
    lines,
    "Key pages",
    context.keyPages.map((page) =>
      [
        `- ${page.url} — ${page.role}`,
        page.topic ? ` · ${page.topic}` : "",
        page.notes ? ` (${page.notes})` : "",
      ].join(""),
    ),
  );

  // The log is capped at the newest entries, so the heading counts what is
  // actually here — an agent deciding whether research is stale must not read
  // a truncated list as the whole 90-day window.
  pushSection(
    lines,
    context.researchLog.length === 0
      ? "Research log"
      : `Research log (${context.researchLog.length} ${
          context.researchLog.length === 1 ? "entry" : "entries"
        })`,
    [
      // Competitors render by domain and key pages by url — the keys their
      // remove ops take. A log entry's only address is its id, so it is the
      // key that has to appear here for removeResearchLog to be usable.
      ...context.researchLog.map(
        (entry) => `- ${entry.entryDate}: ${entry.summary} [id: ${entry.id}]`,
      ),
      ...(context.researchLog.length >= RESEARCH_LOG_LIMIT
        ? [
            "",
            `_Older entries within the ${RESEARCH_LOG_RETENTION_DAYS}-day window are omitted._`,
          ]
        : []),
    ],
  );

  if (context.reportTemplates.length > 0) {
    pushSection(
      lines,
      "Report templates",
      context.reportTemplates.map(
        (template) => `- ${template.name}: ${template.description}`,
      ),
    );
  }

  lines.push(
    context.missingSections.length > 0
      ? `Missing sections: ${context.missingSections.join(", ")}`
      : "Missing sections: none",
  );

  return lines.join("\n");
}

export const ProjectContextService = {
  getProjectContext,
  applyContextUpdates,
  renderProjectContextMarkdown,
} as const;

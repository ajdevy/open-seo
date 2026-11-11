import { and, eq, isNull, sql } from "drizzle-orm";
import { chunk } from "remeda";
import { AppError } from "@/server/lib/errors";
import {
  projects,
  projectContextSections,
  projectCompetitors,
} from "@/db/schema";
import type { SaveProjectWebsiteSetup } from "@/types/schemas/projectWebsite";
import type { ContextAuthor } from "@/types/schemas/projectContext";
import {
  researchKeywordsValue,
  writeConfiguration,
  writeResearchKeywords,
  type ConfigurationRows,
} from "@/server/features/ai-visibility/repositories/aiVisibilityConfigurationRepository";
import {
  commitProjectSettingsMutation,
  makeProjectSettingsSnapshot,
  readProjectSettingsRows,
} from "@/server/features/project-settings-snapshots/snapshotRepository";

export async function saveWebsiteSetup(
  organizationId: string,
  input: SaveProjectWebsiteSetup,
  author: ContextAuthor,
  tracking: ConfigurationRows | null,
) {
  const updatedAt = new Date().toISOString();
  const competitors = input.competitors.map((row) => ({
    ...row,
    id: crypto.randomUUID(),
  }));
  // These literals are server-generated UUIDs, never user input. Inlining
  // them keeps the list guard below D1's bound-parameter limit for 100 rows.
  const insertedIds = sql.raw(competitors.map(({ id }) => `'${id}'`).join(","));
  await commitProjectSettingsMutation(input.projectId, async () => {
    const state = await readProjectSettingsRows(input.projectId);
    if (
      !state ||
      state.project.organizationId !== organizationId ||
      state.project.archivedAt !== null
    )
      throw new AppError("NOT_FOUND");

    // Setup seeds tracking only while none exists; a concurrent first save
    // must remain authoritative when this transaction is retried.
    const trackingToWrite = state.tracker ? null : tracking;
    const keywordNames = input.suggestedTopics?.length
      ? [
          ...input.suggestedTopics.map((topic) => topic.name),
          ...(input.suggestedKeywords ?? []),
        ]
      : [];
    const project = {
      ...state.project,
      domain: state.project.domain ?? input.domain,
      aiResearchKeywords:
        state.project.aiResearchKeywords ??
        (keywordNames.length ? researchKeywordsValue(keywordNames) : null),
    };
    return {
      snapshot: makeProjectSettingsSnapshot({
        ...state,
        project,
        tracker: trackingToWrite?.tracker ?? state.tracker,
        questions: trackingToWrite?.prompts ?? state.questions,
      }),
      write: (tx) => [
        tx
          .update(projects)
          .set({
            domain: sql`coalesce(${projects.domain}, ${input.domain})`,
          })
          .where(
            and(
              eq(projects.id, input.projectId),
              eq(projects.organizationId, organizationId),
              isNull(projects.archivedAt),
            ),
          ),
        // Insert-only writes also preserve edits made after the service read.
        tx
          .insert(projectContextSections)
          .values({
            projectId: input.projectId,
            key: "business_overview",
            title: null,
            content: input.overview,
            updatedBy: author,
            updatedAt,
          })
          .onConflictDoNothing(),
        // D1 rejects a compound SELECT with more than 5 terms.
        ...chunk(competitors, 5).map((rows) =>
          tx
            .insert(projectCompetitors)
            .select(
              sql`
          select * from (${sql.join(
            rows.map(
              ({ id, domain, name, notes }) =>
                sql`select ${id}, ${input.projectId}, ${domain}, ${name}, ${notes}, ${updatedAt}, ${author}`,
            ),
            sql` union all `,
          )}) as researched_competitors
          where not exists (
            select 1 from ${projectCompetitors}
            where ${projectCompetitors.projectId} = ${input.projectId}
              and ${projectCompetitors.id} not in (${insertedIds})
          )
        `,
            )
            .onConflictDoNothing(),
        ),
        ...(trackingToWrite ? writeConfiguration(tx, trackingToWrite) : []),
        // Keyword writes fill an empty field; existing research stays intact.
        ...(keywordNames.length
          ? writeResearchKeywords(tx, input.projectId, keywordNames)
          : []),
      ],
      result: undefined,
    };
  });
}

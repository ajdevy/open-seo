import { createClient } from "@libsql/client";
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
import type { runBatch } from "@/db/runBatch";
import type * as ContextRepositoryModule from "@/server/features/project-context/repositories/ProjectContextRepository";
import type * as ProjectRepositoryModule from "@/server/features/projects/repositories/ProjectRepository";
import type * as SnapshotRepositoryModule from "@/server/features/project-settings-snapshots/snapshotRepository";
import type {
  commitProjectSettingsMutation as CommitProjectSettingsMutation,
  PreparedProjectSettingsMutation,
  ProjectSettingsSnapshot,
  readProjectSettingsRows as ReadProjectSettingsRows,
} from "@/server/features/project-settings-snapshots/snapshotRepository";
import { setupProjectWebsiteSnapshotDb } from "./projectWebsiteSnapshotTestSupport";

const {
  getProject,
  listCompetitors,
  readProjectSettingsRows,
  commitProjectSettingsMutation,
  snapshots,
} = vi.hoisted(() => ({
  getProject:
    vi.fn<
      typeof ProjectRepositoryModule.ProjectRepository.getProjectForOrganization
    >(),
  listCompetitors:
    vi.fn<
      typeof ContextRepositoryModule.ProjectContextRepository.listCompetitors
    >(),
  readProjectSettingsRows: vi.fn<typeof ReadProjectSettingsRows>(),
  commitProjectSettingsMutation: vi.fn<typeof CommitProjectSettingsMutation>(),
  snapshots: [] as ProjectSettingsSnapshot[],
}));
vi.mock("cloudflare:workers", () => ({
  env: { DATABASE_PROVIDER: "d1" },
  waitUntil: vi.fn(),
}));
vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/db/runBatch", () => ({
  runBatch: async (build: Parameters<typeof runBatch>[0]) => {
    if (beforeWrite) await beforeWrite();
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- same Drizzle query surface as the D1 batch executor
    const executor = testDb as unknown as Parameters<typeof build>[0];
    for (const statement of build(executor)) await statement;
  },
}));
vi.mock(
  "@/server/features/project-settings-snapshots/snapshotRepository",
  async () => {
    const actual = await vi.importActual<typeof SnapshotRepositoryModule>(
      "@/server/features/project-settings-snapshots/snapshotRepository",
    );
    return {
      ...actual,
      readProjectSettingsRows,
      commitProjectSettingsMutation,
    };
  },
);
vi.mock("@/server/features/projects/repositories/ProjectRepository", () => ({
  ProjectRepository: { getProjectForOrganization: getProject },
}));
vi.mock(
  "@/server/features/project-context/repositories/ProjectContextRepository",
  async () => {
    const { ProjectContextRepository } = await vi.importActual<
      typeof ContextRepositoryModule
    >(
      "@/server/features/project-context/repositories/ProjectContextRepository",
    );
    return {
      ProjectContextRepository: {
        ...ProjectContextRepository,
        listCompetitors,
      },
    };
  },
);
vi.mock(
  "@/server/features/ai-visibility/services/websiteTrackingSetup",
  () => ({ prepareWebsiteTracking: async () => null }),
);
vi.mock("@/server/features/projects/services/websiteResearch", () => ({
  researchWebsite: vi.fn(),
}));
vi.mock("@/server/billing/subscription", () => ({
  checkUsageCreditsDepleted: vi.fn(),
}));
vi.mock("@/server/lib/runtime-env", () => ({
  isHostedServerAuthMode: async () => false,
}));

import { ProjectWebsiteService } from "./ProjectWebsiteService";
import { customer } from "@/server/features/ai-visibility/services/aiVisibilityTestFixtures";

const client = createClient({ url: "file::memory:" });
const testDb = drizzle(client);
type Tx = Parameters<Parameters<typeof runBatch>[0]>[0];
let beforeWrite: (() => Promise<void>) | null;
async function executePreparedBatch<T>(
  build: PreparedProjectSettingsMutation<T>["write"],
) {
  if (beforeWrite) await beforeWrite();
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- same Drizzle query surface as the D1 batch executor
  const executor = testDb as unknown as Tx;
  for (const statement of build(executor)) await statement;
}
const projectId = "4a5b6c7d-0000-4000-8000-000000000000";
const project = {
  id: projectId,
  organizationId: customer.organizationId,
  name: "Saved name",
  domain: null,
  locationCode: 2840,
  languageCode: "en",
  createdAt: "2026-01-01T00:00:00.000Z",
  archivedAt: null,
  aiResearchKeywords: null,
  indexnowKey: null,
};
const accepted = {
  projectId,
  name: "Researched name",
  domain: "researched.com",
  overview: "Researched overview".padEnd(4000, "."),
  competitors: [
    {
      name: "Researched rival",
      domain: "rival.com",
      notes: "Researched notes",
    },
    { name: "New rival", domain: "new-rival.com", notes: "New notes" },
    ...Array.from({ length: 10 }, (_, index) => ({
      name: `Extra rival ${index}`,
      domain: `extra-rival-${index}.com`,
      notes: "",
    })),
  ],
  suggestedTopics: [
    {
      name: "new keyword",
      prompts: [1, 2, 3, 4, 5].map((n) => `New question ${n}?`),
    },
  ],
  suggestedKeywords: ["site audit"],
};

beforeAll(async () => {
  readProjectSettingsRows.mockImplementation(
    await setupProjectWebsiteSnapshotDb(client),
  );
  commitProjectSettingsMutation.mockImplementation(async (_id, prepare) => {
    const prepared = await prepare();
    snapshots.push(prepared.snapshot);
    await executePreparedBatch(prepared.write);
    return prepared.result;
  });
});
afterAll(() => client.close());
beforeEach(async () => {
  beforeWrite = null;
  snapshots.length = 0;
  getProject.mockResolvedValue(project);
  listCompetitors.mockResolvedValue([]);
  await client.executeMultiple(
    "DELETE FROM project_competitors; DELETE FROM project_context_sections; DELETE FROM projects;",
  );
  await client.execute({
    sql: "INSERT INTO projects (id, organization_id, name) VALUES (?, ?, ?)",
    args: [projectId, customer.organizationId, project.name],
  });
});

async function saveContext() {
  await client.execute({
    sql: "INSERT INTO project_context_sections (project_id, key, content, updated_by) VALUES (?, 'business_overview', 'User overview', 'user')",
    args: [projectId],
  });
  await client.execute({
    sql: "INSERT INTO project_competitors (id, project_id, domain, name, notes, updated_by) VALUES ('saved', ?, 'rival.com', 'User rival', 'User notes', 'user')",
    args: [projectId],
  });
}

describe("ProjectWebsiteService.save", () => {
  it("fills missing fields without replacing an existing project name", async () => {
    await ProjectWebsiteService.save(accepted, customer, "user");
    expect(
      (
        await client.execute(
          "SELECT name, domain, ai_research_keywords FROM projects",
        )
      ).rows,
    ).toEqual([
      {
        name: project.name,
        domain: accepted.domain,
        ai_research_keywords: "new keyword\nsite audit",
      },
    ]);
    expect(
      new Set(
        (
          await client.execute("SELECT domain FROM project_competitors")
        ).rows.map((row) => row.domain),
      ),
    ).toEqual(new Set(accepted.competitors.map((row) => row.domain)));
    expect(
      (await client.execute("SELECT content FROM project_context_sections"))
        .rows[0]?.content,
    ).toBe(accepted.overview);
    const snapshotContext = snapshots[0]?.context;
    expect(snapshotContext?.sections).toEqual([
      {
        key: "business_overview",
        title: null,
        content: accepted.overview,
      },
    ]);
    expect(
      new Set(
        snapshotContext?.competitors.map(
          ({ domain, name, notes }) => `${domain}|${name}|${notes}`,
        ),
      ),
    ).toEqual(
      new Set(
        accepted.competitors.map(
          ({ domain, name, notes }) => `${domain}|${name}|${notes}`,
        ),
      ),
    );
    expect(snapshotContext?.keyPages).toEqual([]);
  });

  it.each(["before review", "during save"])(
    "preserves context saved %s, including the whole competitor list",
    async (timing) => {
      const edit = async () => {
        await saveContext();
        await client.execute(
          "UPDATE projects SET name = 'User name', domain = 'user.com', ai_research_keywords = 'user keyword'",
        );
      };
      if (timing === "before review") {
        await edit();
        listCompetitors.mockResolvedValue([
          {
            id: "existing-rival",
            projectId,
            domain: "rival.com",
            name: "User rival",
            notes: "User notes",
            updatedAt: "2026-11-16T10:00:00.000Z",
            updatedBy: "user",
          },
        ]);
      } else beforeWrite = edit;

      await ProjectWebsiteService.save(accepted, customer, "user");

      expect(
        (
          await client.execute(
            "SELECT name, domain, ai_research_keywords FROM projects",
          )
        ).rows,
      ).toEqual([
        {
          name: "User name",
          domain: "user.com",
          ai_research_keywords: "user keyword",
        },
      ]);
      expect(
        (
          await client.execute(
            "SELECT content, updated_by FROM project_context_sections",
          )
        ).rows,
      ).toEqual([{ content: "User overview", updated_by: "user" }]);
      expect(
        (
          await client.execute(
            "SELECT domain, name, notes FROM project_competitors",
          )
        ).rows,
      ).toEqual([
        { domain: "rival.com", name: "User rival", notes: "User notes" },
      ]);
    },
  );
});

import { beforeEach, expect, it, vi } from "vitest";
import type * as ContextRepositoryModule from "@/server/features/project-context/repositories/ProjectContextRepository";
import type * as SnapshotRepositoryModule from "@/server/features/project-settings-snapshots/snapshotRepository";
import type {
  commitProjectSettingsMutation,
  ProjectSettingsRows,
  ProjectSettingsSnapshot,
  readProjectSettingsRows,
} from "@/server/features/project-settings-snapshots/snapshotRepository";

const mocks = vi.hoisted(() => ({
  listSections:
    vi.fn<
      typeof ContextRepositoryModule.ProjectContextRepository.listSections
    >(),
  listCompetitors:
    vi.fn<
      typeof ContextRepositoryModule.ProjectContextRepository.listCompetitors
    >(),
  listKeyPages:
    vi.fn<
      typeof ContextRepositoryModule.ProjectContextRepository.listKeyPages
    >(),
  listResearchLog:
    vi.fn<
      typeof ContextRepositoryModule.ProjectContextRepository.listResearchLog
    >(),
  listTemplates: vi.fn(async () => []),
  readProjectSettingsRows: vi.fn<typeof readProjectSettingsRows>(),
  commitProjectSettingsMutation: vi.fn<typeof commitProjectSettingsMutation>(),
  snapshots: [] as ProjectSettingsSnapshot[],
}));

vi.mock("cloudflare:workers", () => ({ env: { DATABASE_PROVIDER: "d1" } }));
vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/db/runBatch", () => ({ runBatch: vi.fn() }));
vi.mock(
  "@/server/features/project-context/repositories/ProjectContextRepository",
  () => ({ ProjectContextRepository: mocks }),
);
vi.mock(
  "@/server/features/reports/repositories/ReportTemplateRepository",
  () => ({ ReportTemplateRepository: mocks }),
);
vi.mock(
  "@/server/features/project-settings-snapshots/snapshotRepository",
  async () => {
    const actual = await vi.importActual<typeof SnapshotRepositoryModule>(
      "@/server/features/project-settings-snapshots/snapshotRepository",
    );
    return {
      ...actual,
      readProjectSettingsRows: mocks.readProjectSettingsRows,
      commitProjectSettingsMutation: mocks.commitProjectSettingsMutation,
    };
  },
);

import { applyContextUpdates } from "./ProjectContextService";

const projectId = "project_1";
const timestamp = "2026-08-15T10:00:00.000Z";
const settings: ProjectSettingsRows = {
  project: {
    id: projectId,
    organizationId: "org_1",
    name: "Acme",
    domain: "acme.com",
    locationCode: 2840,
    languageCode: "en",
    createdAt: timestamp,
    archivedAt: null,
    aiResearchKeywords: null,
    indexnowKey: null,
  },
  tracker: null,
  questions: [],
  context: {
    sections: [
      {
        projectId,
        key: "business_overview",
        title: null,
        content: "Existing overview.",
        updatedAt: timestamp,
        updatedBy: "user",
      },
    ],
    competitors: [
      {
        id: "acme",
        projectId,
        domain: "acme.com",
        name: "Acme",
        notes: null,
        updatedAt: timestamp,
        updatedBy: "user",
      },
    ],
    keyPages: [
      {
        id: "pricing",
        projectId,
        url: "https://acme.com/pricing",
        role: "money",
        topic: null,
        notes: null,
        updatedAt: timestamp,
        updatedBy: "user",
      },
    ],
  },
};

beforeEach(() => {
  mocks.snapshots.length = 0;
  mocks.listSections.mockResolvedValue(settings.context.sections);
  mocks.listCompetitors.mockResolvedValue(settings.context.competitors);
  mocks.listKeyPages.mockResolvedValue(settings.context.keyPages);
  mocks.listResearchLog.mockResolvedValue([]);
  mocks.listTemplates.mockResolvedValue([]);
  mocks.readProjectSettingsRows.mockResolvedValue(settings);
  mocks.commitProjectSettingsMutation.mockImplementation(
    async (_id, prepare) => {
      const prepared = await prepare();
      mocks.snapshots.push(prepared.snapshot);
      return prepared.result;
    },
  );
});

it("snapshots existing and changed project memory with settings mutations", async () => {
  await applyContextUpdates(
    projectId,
    [
      { section: "current_goal", content: "Grow qualified trials." },
      { addCompetitors: [{ domain: "newexample.com", notes: "New entrant." }] },
      {
        addKeyPages: [
          { url: "newexample.com/pricing", role: "money", topic: "Plans" },
        ],
      },
    ],
    "user",
  );

  expect(mocks.snapshots).toHaveLength(1);
  expect(mocks.snapshots[0]?.context).toEqual({
    sections: [
      {
        key: "business_overview",
        title: null,
        content: "Existing overview.",
      },
      {
        key: "current_goal",
        title: null,
        content: "Grow qualified trials.",
      },
    ],
    competitors: [
      { domain: "acme.com", name: "Acme", notes: null },
      { domain: "newexample.com", name: null, notes: "New entrant." },
    ],
    keyPages: [
      {
        url: "https://acme.com/pricing",
        role: "money",
        topic: null,
        notes: null,
      },
      {
        url: "https://newexample.com/pricing",
        role: "money",
        topic: "Plans",
        notes: null,
      },
    ],
  });
});

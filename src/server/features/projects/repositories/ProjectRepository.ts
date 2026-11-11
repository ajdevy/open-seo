import { and, count, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { db } from "@/db";
import { getDatabaseProvider } from "@/db/provider";
import { projects } from "@/db/schema";
import { AppError } from "@/server/lib/errors";
import {
  commitProjectSettingsMutation,
  isUniqueViolation,
  makeProjectSettingsSnapshot,
  readProjectSettingsRows,
} from "@/server/features/project-settings-snapshots/snapshotRepository";

async function listProjects(organizationId: string) {
  return db.query.projects.findMany({
    where: and(
      eq(projects.organizationId, organizationId),
      isNull(projects.archivedAt),
    ),
    orderBy: [desc(projects.createdAt), desc(projects.id)],
  });
}

async function countProjects(organizationId: string) {
  const [row] = await db
    .select({ value: count() })
    .from(projects)
    .where(
      and(
        eq(projects.organizationId, organizationId),
        isNull(projects.archivedAt),
      ),
    );
  return row?.value ?? 0;
}

async function getProjectForOrganization(
  projectId: string,
  organizationId: string,
) {
  const [project] = await db
    .select()
    .from(projects)
    .where(
      and(
        eq(projects.id, projectId),
        eq(projects.organizationId, organizationId),
        isNull(projects.archivedAt),
      ),
    )
    .limit(1);
  return project ?? null;
}

// The archived counterpart of getProjectForOrganization, for the surfaces that
// owe the reader "this project is archived" instead of a bare not-found. Still
// org-scoped, so it adds no cross-org existence oracle.
async function getArchivedProjectForOrganization(
  projectId: string,
  organizationId: string,
) {
  const [project] = await db
    .select()
    .from(projects)
    .where(
      and(
        eq(projects.id, projectId),
        eq(projects.organizationId, organizationId),
        isNotNull(projects.archivedAt),
      ),
    )
    .limit(1);
  return project ?? null;
}

// Look up a project by id alone (no org scoping). Only for trusted server
// contexts that have already authorized access another way — e.g. the
// SAM chat Durable Object, whose connections are authorized in the Worker
// before they reach the DO, and which derives its org from the project.
async function getProjectById(projectId: string) {
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), isNull(projects.archivedAt)))
    .limit(1);
  return project ?? null;
}

async function createProject(
  organizationId: string,
  name: string,
  domain?: string,
  // Omitted keeps the column defaults.
  market?: { locationCode: number; languageCode: string },
) {
  const id = crypto.randomUUID();
  await commitProjectSettingsMutation(id, async () => {
    const project = {
      id,
      organizationId,
      name,
      domain: domain ?? null,
      locationCode: market?.locationCode ?? 2840,
      languageCode: market?.languageCode ?? "en",
      createdAt: new Date().toISOString(),
      archivedAt: null,
      aiResearchKeywords: null,
      indexnowKey: null,
    };
    return {
      snapshot: makeProjectSettingsSnapshot({
        project,
        tracker: null,
        questions: [],
      }),
      write: (tx) => [
        tx.insert(projects).values({
          id,
          organizationId,
          name,
          domain: domain ?? null,
          ...market,
        }),
      ],
      result: undefined,
    };
  });
  const [row] = await db
    .select()
    .from(projects)
    .where(
      and(eq(projects.id, id), eq(projects.organizationId, organizationId)),
    )
    .limit(1);
  if (!row) throw new AppError("NOT_FOUND");
  return row;
}

async function updateProject(
  projectId: string,
  organizationId: string,
  input: {
    name: string;
    domain?: string;
    // Omitted leaves the market columns untouched.
    market?: { locationCode: number; languageCode: string };
  },
) {
  await commitProjectSettingsMutation(projectId, async () => {
    const state = await readProjectSettingsRows(projectId);
    if (
      !state ||
      state.project.organizationId !== organizationId ||
      state.project.archivedAt !== null
    )
      throw new AppError("NOT_FOUND");
    const project = {
      ...state.project,
      name: input.name,
      domain: input.domain ?? null,
      ...input.market,
    };
    return {
      snapshot: makeProjectSettingsSnapshot({ ...state, project }),
      write: (tx) => [
        tx
          .update(projects)
          .set({
            name: input.name,
            domain: input.domain ?? null,
            ...input.market,
          })
          .where(
            and(
              eq(projects.id, projectId),
              eq(projects.organizationId, organizationId),
              isNull(projects.archivedAt),
            ),
          ),
      ],
      result: undefined,
    };
  });
  const [row] = await db
    .select()
    .from(projects)
    .where(
      and(
        eq(projects.id, projectId),
        eq(projects.organizationId, organizationId),
        isNull(projects.archivedAt),
      ),
    )
    .limit(1);
  if (!row) throw new AppError("NOT_FOUND");
  return row;
}

// Save website setup atomically without rewriting the project name.
async function updateProjectWebsite(
  projectId: string,
  organizationId: string,
  domain: string,
  market: { locationCode: number; languageCode: string },
) {
  await commitProjectSettingsMutation(projectId, async () => {
    const state = await readProjectSettingsRows(projectId);
    if (
      !state ||
      state.project.organizationId !== organizationId ||
      state.project.archivedAt !== null
    )
      throw new AppError("NOT_FOUND");
    const project = { ...state.project, domain, ...market };
    return {
      snapshot: makeProjectSettingsSnapshot({ ...state, project }),
      write: (tx) => [
        tx
          .update(projects)
          .set({ domain, ...market })
          .where(
            and(
              eq(projects.id, projectId),
              eq(projects.organizationId, organizationId),
              isNull(projects.archivedAt),
            ),
          ),
      ],
      result: undefined,
    };
  });
  const [row] = await db
    .select()
    .from(projects)
    .where(
      and(
        eq(projects.id, projectId),
        eq(projects.organizationId, organizationId),
        isNull(projects.archivedAt),
      ),
    )
    .limit(1);
  if (!row) throw new AppError("NOT_FOUND");
  return row;
}

// Saves the key only if the project has none, so concurrent first uses can't
// leave the site's key file pointing at a key that was overwritten.
async function setIndexNowKeyIfMissing(
  projectId: string,
  organizationId: string,
  key: string,
) {
  await commitProjectSettingsMutation(projectId, async () => {
    const state = await readProjectSettingsRows(projectId);
    if (!state || state.project.organizationId !== organizationId)
      throw new AppError("NOT_FOUND");
    const project = {
      ...state.project,
      indexnowKey: state.project.indexnowKey ?? key,
    };
    return {
      snapshot: makeProjectSettingsSnapshot({ ...state, project }),
      write: (tx) => [
        tx
          .update(projects)
          .set({ indexnowKey: key })
          .where(
            and(
              eq(projects.id, projectId),
              eq(projects.organizationId, organizationId),
              isNull(projects.indexnowKey),
            ),
          ),
      ],
      result: undefined,
    };
  });
}

async function tryCreateDefaultProject(organizationId: string) {
  const id = crypto.randomUUID();
  try {
    await commitProjectSettingsMutation(id, async () => {
      const project = {
        id,
        organizationId,
        name: "Default",
        domain: null,
        locationCode: 2840,
        languageCode: "en",
        createdAt: new Date().toISOString(),
        archivedAt: null,
        aiResearchKeywords: null,
        indexnowKey: null,
      };
      return {
        snapshot: makeProjectSettingsSnapshot({
          project,
          tracker: null,
          questions: [],
        }),
        write: (tx) => [
          tx.insert(projects).values({
            id,
            organizationId,
            name: "Default",
            domain: null,
          }),
        ],
        result: undefined,
      };
    });
    return id;
  } catch (error) {
    // The reserved Default singleton is the only expected conflict here.
    if (isUniqueViolation(error)) {
      const [existing] = await db
        .select({ id: projects.id })
        .from(projects)
        .where(
          and(
            eq(projects.organizationId, organizationId),
            eq(projects.name, "Default"),
            isNull(projects.domain),
            isNull(projects.archivedAt),
          ),
        )
        .limit(1);
      if (existing) return null;
    }
    throw error;
  }
}

async function listArchivedProjects(organizationId: string) {
  return db.query.projects.findMany({
    where: and(
      eq(projects.organizationId, organizationId),
      isNotNull(projects.archivedAt),
    ),
    orderBy: [desc(projects.archivedAt), desc(projects.id)],
  });
}

async function restoreProject(projectId: string, organizationId: string) {
  await commitProjectSettingsMutation(projectId, async () => {
    const state = await readProjectSettingsRows(projectId);
    if (
      !state ||
      state.project.organizationId !== organizationId ||
      state.project.archivedAt === null
    )
      throw new AppError("NOT_FOUND");
    const project = { ...state.project, archivedAt: null };
    return {
      snapshot: makeProjectSettingsSnapshot({ ...state, project }),
      write: (tx) => [
        tx
          .update(projects)
          .set({ archivedAt: null })
          .where(
            and(
              eq(projects.id, projectId),
              eq(projects.organizationId, organizationId),
              isNotNull(projects.archivedAt),
            ),
          ),
      ],
      result: undefined,
    };
  });
}

async function archiveProject(projectId: string, organizationId: string) {
  await commitProjectSettingsMutation(projectId, async () => {
    const state = await readProjectSettingsRows(projectId);
    if (
      !state ||
      state.project.organizationId !== organizationId ||
      state.project.archivedAt !== null
    )
      throw new AppError("NOT_FOUND");
    const now = new Date().toISOString();
    const archivedAt =
      getDatabaseProvider() === "postgres"
        ? now
        : now.slice(0, 19).replace("T", " ");
    const project = { ...state.project, archivedAt };
    return {
      snapshot: makeProjectSettingsSnapshot({ ...state, project }),
      write: (tx) => [
        tx
          .update(projects)
          .set({ archivedAt })
          .where(
            and(
              eq(projects.id, projectId),
              eq(projects.organizationId, organizationId),
              isNull(projects.archivedAt),
            ),
          ),
      ],
      result: undefined,
    };
  });
}

export const ProjectRepository = {
  listProjects,
  listArchivedProjects,
  countProjects,
  getProjectForOrganization,
  getArchivedProjectForOrganization,
  getProjectById,
  createProject,
  updateProject,
  updateProjectWebsite,
  setIndexNowKeyIfMissing,
  tryCreateDefaultProject,
  archiveProject,
  restoreProject,
} as const;

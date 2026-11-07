import { eq } from "drizzle-orm";
import { member, organization, projects, user } from "@/db/schema";
import { AiVisibilityRepository as aiRepo } from "@/server/features/ai-visibility/repositories/AiVisibilityRepository";
import { ProjectContextService } from "@/server/features/project-context/services/ProjectContextService";
import { configuration } from "@/server/features/ai-visibility/services/aiVisibilityTestFixtures";
import { ensureUserMiddleware } from "@/middleware/ensureUser";
import {
  requireAuthenticatedContext,
  requireProjectContext,
} from "@/serverFunctions/middleware";
import { makeToolContext } from "@/server/mcp/tools/tool-test-support";
import type { createAiVisibilityTestDb } from "@/server/features/ai-visibility/aiVisibilityTestDb";
import { expect } from "vitest";

export const story23 = {
  organizationA: "organization",
  organizationB: "client-b",
  userA: "client-a-user",
  userB: "client-b-user",
  projectA: "00000000-0000-4000-8000-000000000101",
  projectB: "00000000-0000-4000-8000-000000000102",
  runA: "00000000-0000-4000-8000-000000000201",
  runB: "00000000-0000-4000-8000-000000000202",
  answerAId: "00000000-0000-4000-8000-000000000301",
  answerBId: "00000000-0000-4000-8000-000000000302",
  answerA: "Client A private answer marker.",
  answerB: "Client B private answer marker.",
  sourceA: "https://a-source.synthetic.test/private",
  sourceB: "https://b-source.synthetic.test/private",
};

const createdAt = new Date("2026-11-01T00:00:00.000Z");
const collectedAt = "2026-11-01T00:00:00.000Z";

// Projects are organization-scoped, not user-owned; AC3's fallback is two
// synthetic users in separate organizations.
export type Story23TestRuntime = {
  testDb: Awaited<ReturnType<typeof createAiVisibilityTestDb>>;
  apiContext: { current: Record<string, unknown> | null };
  requestState: { current: Request };
  sessions: { current: Record<string, unknown> };
  workflow: { create: { mockClear(): unknown }; get: { mockClear(): unknown } };
};

type MiddlewareServerOptions = {
  data: unknown;
  context: unknown;
  method: string;
  serverFnMeta: unknown;
  signal: AbortSignal;
  next: (options?: { context?: unknown }) => Promise<unknown>;
};
type MiddlewareServer = (options: MiddlewareServerOptions) => Promise<unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function isMiddlewareServer(value: unknown): value is MiddlewareServer {
  return typeof value === "function";
}

async function runServerMiddleware(
  middleware: unknown,
  data: unknown,
  context: unknown,
) {
  // TanStack Start exposes middleware as a builder, not a standalone runner.
  if (!isRecord(middleware) || !isRecord(middleware.options))
    throw new Error("The API middleware did not expose its server handler");
  const server = middleware.options.server;
  if (!isMiddlewareServer(server))
    throw new Error("The API middleware did not expose its server handler");

  let forwardedContext: unknown;
  await server({
    data,
    context,
    method: "POST",
    serverFnMeta: {},
    signal: new AbortController().signal,
    next: async (options) => {
      forwardedContext = options?.context;
      return { context: options?.context };
    },
  });
  return forwardedContext;
}

export async function withApiContext<T>(
  runtime: Story23TestRuntime,
  userId: string,
  data: unknown,
  projectScoped: boolean,
  callback: () => Promise<T>,
) {
  runtime.apiContext.current = null;
  runtime.requestState.current = new Request("https://open-seo.test", {
    headers: { "x-test-user": userId },
  });
  const authenticated = await runServerMiddleware(
    ensureUserMiddleware,
    data,
    {},
  );
  const functionMiddleware = projectScoped
    ? requireProjectContext[0]
    : requireAuthenticatedContext[0];
  const context = await runServerMiddleware(
    functionMiddleware,
    data,
    authenticated,
  );
  if (!isRecord(context))
    throw new Error("The API middleware did not pass an authenticated context");
  runtime.apiContext.current = context;
  try {
    return await callback();
  } finally {
    runtime.apiContext.current = null;
  }
}

export async function expectDeniedWithoutContent(
  operation: Promise<unknown>,
  expected: Record<string, unknown>,
  privateMarkers: string | readonly string[],
) {
  let error: unknown;
  try {
    await operation;
  } catch (caught) {
    error = caught;
  }
  const detail = error instanceof Error ? error.message : String(error);
  expect(error).toMatchObject(expected);
  const output = `${detail} ${JSON.stringify(error)}`;
  for (const marker of Array.isArray(privateMarkers)
    ? privateMarkers
    : [privateMarkers]) {
    expect(output).not.toContain(marker);
  }
}

export function mcpContext(userId: string, organizationId: string) {
  return makeToolContext({
    userId,
    userEmail: `${userId}@synthetic.test`,
    organizationId,
  });
}

async function seedAnswer(
  runtime: Story23TestRuntime,
  input: {
    projectId: string;
    trackerId: string;
    promptId: string;
    runId: string;
    observationId: string;
    answer: string;
    source: string;
  },
) {
  await aiRepo.createRun(
    {
      id: input.runId,
      trackerId: input.trackerId,
      projectId: input.projectId,
      trigger: "manual",
      status: "completed",
      locationCode: 2840,
      languageCode: "en",
      createdAt: collectedAt,
      completedAt: collectedAt,
    },
    [
      {
        id: input.observationId,
        runId: input.runId,
        promptId: input.promptId,
        engine: "chatgpt",
        branded: false,
        status: "completed",
        answerMarkdown: input.answer,
        collectedAt,
      },
    ],
  );
  await aiRepo.persistAnswer({
    observationId: input.observationId,
    values: { status: "completed", answerMarkdown: input.answer },
    sources: [
      {
        id: crypto.randomUUID(),
        observationId: input.observationId,
        url: input.source,
        domain: new URL(input.source).hostname,
        title: `${input.projectId} synthetic source`,
        position: 1,
      },
    ],
    matches: [],
  });
}

export async function seedStory23Fixture(runtime: Story23TestRuntime) {
  const {
    organizationA,
    organizationB,
    userA,
    userB,
    projectA,
    projectB,
    runA,
    runB,
    answerAId,
    answerBId,
    answerA,
    answerB,
    sourceA,
    sourceB,
  } = story23;
  const { testDb } = runtime;
  await testDb.seedProject();
  await testDb.db.delete(user);
  runtime.apiContext.current = null;
  runtime.workflow.create.mockClear();
  runtime.workflow.get.mockClear();

  await testDb.db
    .update(projects)
    .set({ id: projectA, name: "Client A", domain: "client-a.synthetic.test" })
    .where(eq(projects.id, "project"));
  await testDb.db.insert(organization).values({
    id: organizationB,
    name: "Synthetic Client B",
    slug: "synthetic-client-b",
    createdAt,
  });
  await testDb.db.insert(projects).values({
    id: projectB,
    organizationId: organizationB,
    name: "Client B",
    domain: "client-b.synthetic.test",
  });
  await testDb.db.insert(user).values([
    {
      id: userA,
      name: "Synthetic Client A User",
      email: "client-a@synthetic.test",
      emailVerified: true,
      createdAt,
      updatedAt: createdAt,
    },
    {
      id: userB,
      name: "Synthetic Client B User",
      email: "client-b@synthetic.test",
      emailVerified: true,
      createdAt,
      updatedAt: createdAt,
    },
  ]);
  await testDb.db.insert(member).values([
    {
      id: "member-client-a",
      organizationId: organizationA,
      userId: userA,
      role: "owner",
      createdAt,
    },
    {
      id: "member-client-b",
      organizationId: organizationB,
      userId: userB,
      role: "owner",
      createdAt,
    },
  ]);
  runtime.sessions.current = {
    [userA]: {
      user: {
        id: userA,
        email: "client-a@synthetic.test",
        emailVerified: true,
      },
      session: { activeOrganizationId: organizationA },
    },
    [userB]: {
      user: {
        id: userB,
        email: "client-b@synthetic.test",
        emailVerified: true,
      },
      session: { activeOrganizationId: organizationB },
    },
  };

  const configA = configuration(
    { engines: ["chatgpt"], prompts: [{ text: "Client A private question?" }] },
    projectA,
  );
  const configB = configuration(
    { engines: ["chatgpt"], prompts: [{ text: "Client B private question?" }] },
    projectB,
  );
  await aiRepo.saveConfiguration(configA);
  await aiRepo.saveConfiguration(configB);
  await seedAnswer(runtime, {
    projectId: projectA,
    trackerId: configA.tracker.id,
    promptId: configA.prompts[0].id,
    runId: runA,
    observationId: answerAId,
    answer: answerA,
    source: sourceA,
  });
  await seedAnswer(runtime, {
    projectId: projectB,
    trackerId: configB.tracker.id,
    promptId: configB.prompts[0].id,
    runId: runB,
    observationId: answerBId,
    answer: answerB,
    source: sourceB,
  });

  await ProjectContextService.applyContextUpdates(
    projectA,
    [
      { section: "business_overview", content: "Client A private settings." },
      {
        addCompetitors: [{ domain: "a-rival.example.com", name: "A rival" }],
      },
    ],
    "user",
  );
  await ProjectContextService.applyContextUpdates(
    projectB,
    [
      { section: "business_overview", content: "Client B private settings." },
      {
        addCompetitors: [{ domain: "b-rival.example.com", name: "B rival" }],
      },
    ],
    "user",
  );
}

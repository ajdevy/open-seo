import { beforeEach, vi } from "vitest";
import type * as TanstackReactStart from "@tanstack/react-start";
import { registerApiAccessCases } from "./tenant-access.story-2-3.api-cases";
import { registerMcpAccessCases } from "./tenant-access.story-2-3.mcp-cases";
import { registerProjectSettingsCases } from "./tenant-access.story-2-3.settings-cases";
import { seedStory23Fixture } from "./tenant-access.story-2-3.test-support";

const { testDb, apiContext, requestState, sessions, workflow } =
  await vi.hoisted(async () => {
    const { createAiVisibilityTestDb } =
      await import("@/server/features/ai-visibility/aiVisibilityTestDb");
    return {
      testDb: await createAiVisibilityTestDb(),
      apiContext: { current: null as Record<string, unknown> | null },
      requestState: { current: new Request("https://open-seo.test") },
      sessions: { current: {} as Record<string, unknown> },
      workflow: { create: vi.fn(), get: vi.fn() },
    };
  });

vi.mock("@tanstack/react-start", async (importOriginal) => {
  const actual = await importOriginal<typeof TanstackReactStart>();
  return {
    ...actual,
    createServerFn: () => {
      let validator: { parse: (value: unknown) => unknown } | undefined;
      const builder = {
        middleware: () => builder,
        validator: (schema: { parse: (value: unknown) => unknown }) => {
          validator = schema;
          return builder;
        },
        handler:
          (handler: (input: { data: unknown; context: unknown }) => unknown) =>
          async (input: { data?: unknown } = {}) => {
            if (!apiContext.current)
              throw new Error("Test API context was not authorized");
            return handler({
              data: validator ? validator.parse(input.data) : input.data,
              context: apiContext.current,
            });
          },
      };
      return builder;
    },
  };
});
vi.mock("@tanstack/react-start/server", () => ({
  getRequest: () => requestState.current,
}));
vi.mock("@/lib/auth", () => ({
  hasBetterAuthConfig: () => true,
  getAuth: () => ({
    api: {
      getSession: async ({ headers }: { headers: Headers }) =>
        sessions.current[headers.get("x-test-user") ?? ""] ?? null,
    },
  }),
}));
vi.mock("@/db", () => ({ db: testDb.db }));
vi.mock("@/db/runBatch", () => ({ runBatch: testDb.runBatch }));
vi.mock("cloudflare:workers", () => ({
  env: {
    AUTH_MODE: "hosted",
    DATABASE_PROVIDER: "d1",
    AI_VISIBILITY_WORKFLOW: workflow,
  },
  waitUntil: vi.fn(),
}));
vi.mock("@/server/lib/runtime-env", () => ({
  getOptionalEnvValue: async () => null,
  isHostedServerAuthMode: async () => false,
}));

const runtime = { testDb, apiContext, requestState, sessions, workflow };
beforeEach(async () => seedStory23Fixture(runtime));
registerApiAccessCases(runtime);
registerMcpAccessCases(runtime);
registerProjectSettingsCases(runtime);

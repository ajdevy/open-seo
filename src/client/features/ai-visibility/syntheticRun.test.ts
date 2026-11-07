import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAiVisibilityNativeRun } from "@/serverFunctions/ai-visibility";
import { createSyntheticRun } from "./syntheticRun";

const mocks = vi.hoisted(() => ({
  createRun: vi.fn(),
  paidRun: vi.fn(),
}));

vi.mock("@/serverFunctions/ai-visibility", () => ({
  createAiVisibilityNativeRun: mocks.createRun,
  runAiVisibilityCheck: mocks.paidRun,
}));

const projectId = "00000000-0000-4000-8000-000000000101";
const questionId = "00000000-0000-4000-8000-000000000102";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createAiVisibilityNativeRun).mockResolvedValue({
    run: {
      id: "00000000-0000-4000-8000-000000000201",
      status: "running",
      trigger: "manual",
      expected: 0,
      completed: 0,
      failed: 0,
      pending: 0,
      createdAt: "2026-11-07T12:00:00.000Z",
      completedAt: null,
      pollAfterSeconds: 5,
    },
    tasks: [],
  });
});

describe("synthetic UI run creation", () => {
  it("creates project-scoped pending tasks without calling the paid run route", async () => {
    const targets = [{ requestedModel: "model-a", route: "codex_cli" }];

    await createSyntheticRun(projectId, [questionId], targets);

    expect(createAiVisibilityNativeRun).toHaveBeenCalledTimes(1);
    expect(createAiVisibilityNativeRun).toHaveBeenCalledWith({
      data: { projectId, questionIds: [questionId], targets },
    });
    expect(mocks.paidRun).not.toHaveBeenCalled();
  });
});

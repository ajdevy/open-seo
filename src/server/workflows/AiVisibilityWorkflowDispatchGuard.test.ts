import type { WorkflowStep } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AiVisibilityWorkflow } from "./AiVisibilityWorkflow";

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  post: vi.fn(),
  live: vi.fn(),
  model: vi.fn(),
  collect: vi.fn(),
  late: vi.fn(),
  settle: vi.fn(),
  hasReservation: vi.fn(),
  markUnknown: vi.fn(),
  release: vi.fn(),
  settleBudget: vi.fn(),
  finalize: vi.fn(),
  markFailed: vi.fn(),
  steps: vi.fn(),
  replayProviderSteps: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: vi.fn() }));
vi.mock("cloudflare:workflows", () => ({
  NonRetryableError: class extends Error {},
}));
vi.mock("@/server/features/ai-visibility/services/aiResearchKeywords", () => ({
  runAiResearchSetup: vi.fn(),
}));
vi.mock(
  "@/server/features/ai-visibility/services/aiVisibilityCollection",
  () => ({
    prepareAiRun: mocks.prepare,
    postAiBatch: mocks.post,
    collectAiLiveBatch: mocks.live,
    collectAiModelBatch: mocks.model,
    collectAiRound: mocks.collect,
    collectLateAiAnswers: mocks.late,
  }),
);
vi.mock(
  "@/server/features/ai-visibility/services/aiVisibilityRunOutcome",
  () => ({
    finalizeAiRun: mocks.finalize,
    markAiRunFailed: mocks.markFailed,
  }),
);
vi.mock("@/server/features/ai-visibility/services/aiVisibilityBilling", () => ({
  settleAiRun: mocks.settle,
}));
vi.mock(
  "@/server/features/ai-visibility/repositories/AiProviderRunBudgetRepository",
  () => ({
    hasReservedAiProviderRunBudget: mocks.hasReservation,
    markAiProviderRunBudgetUnknown: mocks.markUnknown,
    releaseAiProviderRunBudget: mocks.release,
    settleAiProviderRunBudget: mocks.settleBudget,
  }),
);
vi.mock("@/server/lib/dataforseo", () => ({
  AI_TRACKING_HOLD_TTL_MS: 86_400_000,
}));
vi.mock("./pgStep", () => ({
  pgStep: (
    _step: unknown,
    name: string,
    _config: unknown,
    fn: () => Promise<unknown>,
  ) => {
    mocks.steps(name);
    // Model Cloudflare replaying old paid-step results without invoking the
    // callback. The new reservation step must still run before that replay.
    if (mocks.replayProviderSteps() && (name === "post-0" || name === "live-0"))
      return Promise.resolve({ cached: true });
    return fn();
  },
}));

const customer = {
  organizationId: "organization",
  userId: "user",
  userEmail: "user@example.com",
};
const task = { tag: "answer", taskId: "task", engine: "chatgpt" };

function execute() {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- minimal test runtime boundary
  const workflow = new AiVisibilityWorkflow({} as ExecutionContext, {} as Env);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- only sleep methods are read
  const step = {
    sleep: vi.fn(),
    sleepUntil: vi.fn(),
  } as unknown as WorkflowStep;
  return workflow.run(
    {
      payload: { runId: "legacy-run", customer },
      instanceId: "legacy-run",
      timestamp: new Date(),
    },
    step,
  );
}

describe("AI visibility workflow dispatch guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.replayProviderSteps.mockReturnValue(false);
    mocks.hasReservation.mockResolvedValue(false);
    mocks.prepare.mockResolvedValue({
      market: { locationCode: 2840, languageCode: "en" },
      modelBatches: [],
      live: false,
      batches: [{ engine: "chatgpt", tasks: [task] }],
    });
  });

  it("blocks replayed queued, live, and model provider steps without a reservation", async () => {
    mocks.replayProviderSteps.mockReturnValue(true);
    mocks.prepare
      .mockResolvedValueOnce({
        market: { locationCode: 2840, languageCode: "en" },
        modelBatches: [[task]],
        live: false,
        batches: [{ engine: "chatgpt", tasks: [task] }],
      })
      .mockResolvedValueOnce({
        market: { locationCode: 2840, languageCode: "en" },
        modelBatches: [],
        live: true,
        batches: [[task]],
      });
    await execute();
    await execute();

    expect(mocks.hasReservation).toHaveBeenCalledTimes(3);
    expect(mocks.steps).toHaveBeenCalledWith("provider-budget-post-0");
    expect(mocks.steps).toHaveBeenCalledWith("provider-budget-live-0");
    expect(mocks.steps).toHaveBeenCalledWith("provider-budget-model-0");
    expect(mocks.steps).not.toHaveBeenCalledWith("post-0");
    expect(mocks.steps).not.toHaveBeenCalledWith("live-0");
    expect(mocks.steps).not.toHaveBeenCalledWith("model-0");
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.live).not.toHaveBeenCalled();
    expect(mocks.model).not.toHaveBeenCalled();
    expect(mocks.settleBudget).not.toHaveBeenCalled();
  });

  it("settles zero when the provider call is proven not to have started", async () => {
    mocks.hasReservation.mockResolvedValue(true);
    mocks.prepare.mockResolvedValue({
      market: { locationCode: 2840, languageCode: "en" },
      modelBatches: [],
      live: false,
      batches: [{ engine: "chatgpt", tasks: [task] }],
    });
    mocks.post.mockResolvedValue({
      pending: [],
      hold: null,
      providerCostUsd: 0,
      providerCostKnown: true,
      providerCallMayHaveStarted: false,
    });

    await execute();

    expect(mocks.settleBudget).toHaveBeenCalledExactlyOnceWith(
      "legacy-run",
      0,
      expect.any(String),
    );
    expect(mocks.markUnknown).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
  });
});

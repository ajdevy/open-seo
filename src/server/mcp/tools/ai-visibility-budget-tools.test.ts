import { beforeEach, describe, expect, it, vi } from "vitest";
import * as definitions from "./ai-visibility-tools";
import { makeToolContext, textContent } from "./tool-test-support";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  service: { estimateCost: vi.fn() },
}));
vi.mock("cloudflare:workers", () => ({
  env: {},
  waitUntil: vi.fn(),
  DurableObject: class {
    kind = "mock";
  },
}));
vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: { getProjectForOrganization: mocks.authorize },
}));
vi.mock("@/server/features/ai-visibility/services/AiVisibilityService", () => ({
  AiVisibilityService: mocks.service,
}));

const projectId = "00000000-0000-4000-8000-000000000001";
const context = makeToolContext();

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorize.mockResolvedValue({ id: projectId, domain: "example.com" });
  mocks.service.estimateCost.mockResolvedValue({
    promptCount: 1,
    engineCount: 1,
    observations: 1,
    providerCostUsd: 0.12,
    runNowProviderCostUsd: 0.24,
    costUsd: 0.12,
    costCredits: 120,
    runNowCostUsd: 0.24,
    runNowCostCredits: 240,
    scheduleInterval: "weekly",
    checksPerMonth: 4,
    monthlyCostUsd: 0.48,
    weeklyProviderBudgetUsd: 8,
    weeklyProviderBudgetAccountedUsd: 0.5,
    weeklyProviderBudgetHeldUsd: 0.25,
    weeklyProviderBudgetAvailableUsd: 7.25,
    weeklyProviderBudgetGlobalAvailableUsd: 7.25,
    weeklyProjectProviderBudgetUsd: 8,
    weeklyProjectProviderBudgetAccountedUsd: 0.5,
    weeklyProjectProviderBudgetHeldUsd: 0.25,
    weeklyProjectProviderBudgetAvailableUsd: 7.25,
    runNowProviderBudgetRemainingUsd: 7.01,
    weeklyProviderBudgetScope: "installation",
    weeklyProviderBudgetWindowDays: 7,
    currency: "USD",
    warnings: [],
  });
});

describe("AI visibility cost estimate output", () => {
  it("returns the installation-wide and project rolling budgets", async () => {
    const result = await definitions.estimateAiVisibilityCostTool.handler(
      { projectId },
      context,
    );

    expect(result.structuredContent).toMatchObject({
      data: {
        weeklyProviderBudgetUsd: 8,
        weeklyProviderBudgetAvailableUsd: 7.25,
        weeklyProviderBudgetGlobalAvailableUsd: 7.25,
        weeklyProjectProviderBudgetUsd: 8,
        weeklyProjectProviderBudgetAvailableUsd: 7.25,
        weeklyProviderBudgetScope: "installation",
        weeklyProviderBudgetWindowDays: 7,
      },
    });
    expect(
      definitions.estimateAiVisibilityCostTool.config.outputSchema.safeParse(
        result.structuredContent,
      ).success,
    ).toBe(true);
    expect(textContent(result)).toContain(
      "Rolling 7-day installation-wide provider budget",
    );
  });
});

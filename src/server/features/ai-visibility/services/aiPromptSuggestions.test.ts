import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  buildChatAgentModel,
  checkUsageCreditsDepleted,
  getConfiguration,
  getProjectForOrganization,
  generateText,
  listCompetitors,
  listSections,
  requireOpenRouterAccess,
  isHostedServerAuthMode,
  billResearchSpend,
} = vi.hoisted(() => ({
  buildChatAgentModel: vi.fn(),
  checkUsageCreditsDepleted: vi.fn(),
  getConfiguration: vi.fn(),
  getProjectForOrganization: vi.fn(),
  generateText: vi.fn(),
  listCompetitors: vi.fn(),
  listSections: vi.fn(),
  requireOpenRouterAccess: vi.fn(),
  isHostedServerAuthMode: vi.fn(),
  billResearchSpend: vi.fn(),
}));

vi.mock("ai", () => ({
  generateText,
  Output: { object: (value: unknown) => value },
}));
vi.mock(
  "@/server/features/ai-visibility/repositories/AiVisibilityRepository",
  () => ({
    AiVisibilityRepository: { getConfiguration },
  }),
);
vi.mock("@/server/features/projects/repositories/ProjectRepository", () => ({
  ProjectRepository: { getProjectForOrganization },
}));
vi.mock(
  "@/server/features/project-context/repositories/ProjectContextRepository",
  () => ({
    ProjectContextRepository: { listSections, listCompetitors },
  }),
);
vi.mock("@/server/billing/subscription", () => ({
  checkUsageCreditsDepleted,
}));
vi.mock("@/server/billing/researchSpend", () => ({ billResearchSpend }));
vi.mock("@/server/lib/chatAgent", () => ({
  requireOpenRouterCostUsd: vi.fn(),
}));
vi.mock("@/server/lib/openrouter", () => ({
  buildChatAgentModel,
  requireOpenRouterAccess,
}));
vi.mock("@/server/lib/runtime-env", () => ({
  getOptionalEnvValue: vi.fn(),
  isHostedServerAuthMode,
}));

import { generateAiPrompts } from "./aiPromptSuggestions";
import { customer } from "./aiVisibilityTestFixtures";

describe("generateAiPrompts", () => {
  beforeEach(() => {
    getProjectForOrganization.mockResolvedValue({
      id: "project",
      name: "OpenSEO",
      domain: "openseo.so",
    });
    getConfiguration.mockResolvedValue(null);
    listSections.mockResolvedValue([]);
    listCompetitors.mockResolvedValue([]);
    isHostedServerAuthMode.mockResolvedValue(false);
    checkUsageCreditsDepleted.mockResolvedValue({ depleted: false });
  });

  it("blocks uncached paid generation before dispatching to OpenRouter", async () => {
    await expect(
      generateAiPrompts(
        {
          projectId: "00000000-0000-4000-8000-000000000001",
          locationCode: 2840,
          languageCode: "en",
          excludePrompts: [],
        },
        customer,
      ),
    ).rejects.toMatchObject({
      reason: "PROVIDER_COST_CEILING_UNAVAILABLE",
    });

    expect(requireOpenRouterAccess).not.toHaveBeenCalled();
    expect(buildChatAgentModel).not.toHaveBeenCalled();
    expect(generateText).not.toHaveBeenCalled();
    expect(billResearchSpend).not.toHaveBeenCalled();
  });
});

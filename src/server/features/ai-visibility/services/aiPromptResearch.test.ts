import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ waitUntil: vi.fn() }));

const {
  assertPaidPlan,
  mentionsSearch,
  generateText,
  billResearchSpend,
  isHosted,
  creditsDepleted,
  getCached,
  getTracker,
  listResearchKeywords,
} = vi.hoisted(() => ({
  assertPaidPlan: vi.fn(),
  mentionsSearch: vi.fn(),
  generateText: vi.fn(),
  billResearchSpend: vi.fn(),
  isHosted: vi.fn(),
  creditsDepleted: vi.fn(),
  getCached: vi.fn(),
  getTracker: vi.fn(),
  listResearchKeywords: vi.fn(),
}));

vi.mock("ai", () => ({
  generateText,
  Output: { object: (value: unknown) => value },
}));
vi.mock("@/server/lib/openrouter", () => ({
  buildChatAgentModel: vi.fn(),
  requireOpenRouterAccess: async () => ({ apiKey: "key" }),
}));
vi.mock("@/server/lib/chatAgent", () => ({
  requireOpenRouterCostUsd: () => 0.003,
}));
vi.mock("@/server/lib/runtime-env", () => ({
  getRequiredEnvValue: async () => "key",
  getOptionalEnvValue: vi.fn(),
  isHostedServerAuthMode: isHosted,
}));
vi.mock("@/server/billing/researchSpend", () => ({ billResearchSpend }));
vi.mock("@/server/billing/subscription", () => ({
  checkUsageCreditsDepleted: creditsDepleted,
}));
vi.mock("@/server/lib/dataforseo", () => ({
  CHATGPT_LANGUAGE_CODE: "en",
  CHATGPT_LOCATION_CODE: 2840,
  createDataforseoClient: () => ({ aiSearch: { mentionsSearch } }),
}));
vi.mock("@/server/lib/r2-cache", () => ({
  buildCacheKey: async (prefix: string) => prefix,
  getCached,
  setCached: async () => undefined,
}));
vi.mock("./aiVisibilityState", () => ({ getTracker }));
vi.mock("@/server/features/ai-search/services/access", () => ({
  assertPaidAiSearchPlan: assertPaidPlan,
}));
vi.mock("../repositories/AiVisibilityRepository", () => ({
  AiVisibilityRepository: { listResearchKeywords },
}));
vi.mock("@/server/features/projects/repositories/ProjectRepository", () => ({
  ProjectRepository: { getProjectForOrganization: async () => null },
}));
vi.mock(
  "@/server/features/project-context/repositories/ProjectContextRepository",
  () => ({ ProjectContextRepository: { listSections: async () => [] } }),
);

import { listAiResearchKeywords, researchAiPrompts } from "./aiPromptResearch";
import { customer } from "./aiVisibilityTestFixtures";

const input = { projectId: "project", keyword: "seo tool" } as const;

describe("researchAiPrompts", () => {
  beforeEach(() => {
    assertPaidPlan.mockResolvedValue(undefined);
    isHosted.mockResolvedValue(true);
    creditsDepleted.mockResolvedValue({ depleted: false });
    getCached.mockResolvedValue(null);
    getTracker.mockResolvedValue({
      brands: [
        { own: true, name: "OpenSEO", domain: "openseo.so", aliases: [] },
      ],
      prompts: [{ text: "Is Moz a good SEO tool?", archived: false }],
    });
    mentionsSearch.mockResolvedValue([
      {
        question: "what is the most accurate seo tool?",
        answer: "Ahrefs or OpenSEO.",
        ai_search_volume: 40,
        sources: [
          { domain: "www.openseo.so", url: "https://www.openseo.so/a" },
        ],
      },
      {
        question: "What is the most accurate SEO tool in 2026?",
        ai_search_volume: 138,
        sources: [{ domain: "forbes.com", url: "https://forbes.com/b" }],
      },
      { question: "is moz a good seo tool?", ai_search_volume: 71 },
      {
        question: "what does the seo tool and die company make?",
        ai_search_volume: 90,
      },
    ]);
    // Ids follow provider order. The tool-and-die company asks the keyword
    // phrase but means something else, so the model leaves it out.
    generateText.mockImplementation(
      async ({ onStepFinish }: { onStepFinish: (step: object) => unknown }) => {
        await onStepFinish({});
        return { output: { relevant: [0, 1, 2] } };
      },
    );
  });

  it("blocks uncached paid provider dispatch until the shared budget can reserve it", async () => {
    await expect(researchAiPrompts(input, customer)).rejects.toMatchObject({
      reason: "PROVIDER_COST_CEILING_UNAVAILABLE",
    });

    expect(mentionsSearch).not.toHaveBeenCalled();
    expect(generateText).not.toHaveBeenCalled();
    expect(billResearchSpend).not.toHaveBeenCalled();
  });

  it("filters and merges cached research without a provider call", async () => {
    getCached.mockImplementation(async (key: string) => {
      if (key === "ai-visibility:prompt-research")
        return {
          prompts: [
            {
              question: "what is the most accurate seo tool?",
              answer: "Ahrefs or OpenSEO.",
              volume: 40,
              sources: [
                {
                  domain: "www.openseo.so",
                  url: "https://www.openseo.so/a",
                  title: null,
                },
              ],
            },
            {
              question: "What is the most accurate SEO tool in 2026?",
              answer: "Ahrefs or OpenSEO.",
              volume: 138,
              sources: [
                {
                  domain: "forbes.com",
                  url: "https://forbes.com/b",
                  title: null,
                },
              ],
            },
            {
              question: "is moz a good seo tool?",
              answer: "Moz has useful tools.",
              volume: 71,
              sources: [],
            },
          ],
        };
      if (key === "ai-visibility:prompt-relevance")
        return [
          "what is the most accurate seo tool?",
          "What is the most accurate SEO tool in 2026?",
          "is moz a good seo tool?",
        ];
      return null;
    });

    const result = await researchAiPrompts(input, customer);

    expect(result.prompts).toMatchObject([
      {
        text: "What is the most accurate SEO tool in 2026?",
        variants: ["What is the most accurate seo tool?"],
        ownDomainCited: true,
        brandMentioned: true,
        tracked: false,
      },
      { text: "Is moz a good seo tool?", tracked: true, sources: [] },
    ]);
    expect(mentionsSearch).not.toHaveBeenCalled();
    expect(generateText).not.toHaveBeenCalled();
    expect(billResearchSpend).not.toHaveBeenCalled();
  });

  it("refuses research when hosted credits are used up before buying any data", async () => {
    creditsDepleted.mockResolvedValue({ depleted: true });

    await expect(researchAiPrompts(input, customer)).rejects.toMatchObject({
      code: "INSUFFICIENT_CREDITS",
    });
    expect(mentionsSearch).not.toHaveBeenCalled();
    expect(generateText).not.toHaveBeenCalled();
  });

  it("refuses research without the paid plan before buying any data", async () => {
    assertPaidPlan.mockRejectedValue(new Error("PAYMENT_REQUIRED"));

    await expect(researchAiPrompts(input, customer)).rejects.toThrow(
      "PAYMENT_REQUIRED",
    );
    expect(mentionsSearch).not.toHaveBeenCalled();
    expect(generateText).not.toHaveBeenCalled();
  });

  it("does not buy the same research or relevance check twice within the cache window", async () => {
    getCached.mockImplementation(async (key: string) =>
      key === "ai-visibility:prompt-research"
        ? {
            prompts: [
              {
                question: "which seo tool is free?",
                answer: "",
                volume: 45,
                sources: [],
              },
            ],
          }
        : ["which seo tool is free?"],
    );

    const result = await researchAiPrompts(input, customer);

    expect(mentionsSearch).not.toHaveBeenCalled();
    expect(generateText).not.toHaveBeenCalled();
    expect(result.prompts[0].text).toBe("Which seo tool is free?");
  });

  it("blocks an uncached relevance request even when prompt research is cached", async () => {
    getCached.mockImplementation(async (key: string) =>
      key === "ai-visibility:prompt-research"
        ? {
            prompts: [
              {
                question: "which seo tool is free?",
                answer: "OpenSEO offers a free plan.",
                volume: 45,
                sources: [],
              },
            ],
          }
        : null,
    );

    await expect(researchAiPrompts(input, customer)).rejects.toMatchObject({
      reason: "PROVIDER_COST_CEILING_UNAVAILABLE",
    });

    expect(mentionsSearch).not.toHaveBeenCalled();
    expect(generateText).not.toHaveBeenCalled();
    expect(billResearchSpend).not.toHaveBeenCalled();
  });
});

describe("listAiResearchKeywords", () => {
  it("lists setup keywords, then tracker topics except General, without a provider call", async () => {
    getTracker.mockResolvedValue({
      topics: ["Backlinks", "General", "SEO tool"],
    });
    listResearchKeywords.mockResolvedValue(["Rank tracker", "seo tool"]);

    const result = await listAiResearchKeywords({ projectId: "project" });

    expect(result.keywords).toEqual(["rank tracker", "seo tool", "backlinks"]);
  });
});

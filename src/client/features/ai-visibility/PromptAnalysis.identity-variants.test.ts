import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AiPrompt } from "@/shared/ai-visibility";
import type { getAiVisibilityResults } from "@/serverFunctions/ai-visibility";
import { projectBrandIdentityVariants } from "@/client/features/projects/project-context/brandIdentityVariants";
import { PromptAnalysis } from "./PromptAnalysis";

vi.mock("@/serverFunctions/ai-visibility", () => ({
  getAiVisibilityAnswer: vi.fn(),
  getAiVisibilityRun: vi.fn(),
  getAiVisibilityResults: vi.fn(),
  getAiVisibilitySources: vi.fn(),
  getAiVisibilityTracker: vi.fn(),
}));
vi.mock("./PromptAnswers", () => ({
  PromptAnswers: () => createElement("div", null, "Answer evidence"),
}));
vi.mock("./PromptExecutions", () => ({
  PromptExecutions: () => createElement("div", null, "Executions"),
}));
vi.mock("./PromptDateRange", () => ({
  PromptDateRange: () => createElement("div"),
  PromptRange: { All: "all" },
  inPromptPeriod: () => true,
  promptPeriod: () => "all",
}));

const prompt: AiPrompt = {
  id: "prompt-a",
  text: "Which product should I use?",
  topic: "General",
  paused: false,
  archived: false,
  branded: false,
  hasResults: true,
};

const history: Awaited<ReturnType<typeof getAiVisibilityResults>> = {
  runId: "run-a",
  run: null,
  historyRuns: [
    {
      id: "run-a",
      createdAt: "2026-11-07T00:00:00.000Z",
      trigger: "manual",
    },
  ],
  rows: [
    {
      id: "observation-a",
      runId: "run-a",
      promptId: "prompt-a",
      prompt: prompt.text,
      topic: "General",
      branded: false,
      engine: "chatgpt",
      status: "completed",
      answerStatus: "answered",
      brands: [
        {
          name: "Acme",
          domain: "acme.example",
          own: true,
          mentioned: false,
          cited: false,
          firstMention: null,
        },
      ],
      citationCount: 0,
      collectedAt: "2026-11-07T00:00:00.000Z",
      error: null,
    },
  ],
  nativeResults: [],
  totalCount: 1,
  summaries: [],
  coverage: { expected: 1, completed: 1, noAnswer: 0, failed: 0, pending: 0 },
  appliedFilters: {
    topic: undefined,
    engines: undefined,
    competitorGap: false,
    branded: "all",
  },
  truncated: false,
};

describe("prompt report identity variants", () => {
  it("shows the project's saved variants alongside its own brand", () => {
    const identityVariants = projectBrandIdentityVariants([
      { slug: "brand-identity-variants", content: "Acme Cloud\nACME.io" },
      { slug: "other-project-note", content: "Do not show this" },
    ]);
    const html = renderToStaticMarkup(
      createElement(PromptAnalysis, {
        projectId: "project-a",
        prompt,
        history,
        identityVariants,
      }),
    );

    expect(html).toContain("Also known as: Acme Cloud, ACME.io");
    expect(html).not.toContain("Do not show this");
  });
});

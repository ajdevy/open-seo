import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { AnswerContent } from "./AnswerContent";

const { getAnswer } = vi.hoisted(() => ({ getAnswer: vi.fn() }));

vi.mock("@/serverFunctions/ai-visibility", () => ({
  getAiVisibilityAnswer: getAnswer,
}));
vi.mock("./shared", () => ({
  AiLoading: () => createElement("div", null, "Loading answer"),
  AiMatchBadge: () => createElement("span"),
  AiQueryError: () =>
    createElement("div", null, "Could not load AI visibility"),
  aiVisibilityKey: (projectId: string) => ["aiVisibility", projectId],
}));

describe("foreign answer ID handling", () => {
  it("does not render answer content when the project-scoped lookup is denied", async () => {
    getAnswer.mockRejectedValue(
      Object.assign(new Error("Not found"), { code: "NOT_FOUND" }),
    );
    const projectId = "project-a";
    const observationId = "foreign-observation-id";
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false, retryOnMount: false },
      },
    });
    await client.prefetchQuery({
      queryKey: ["aiVisibility", projectId, "answer", observationId],
      queryFn: () => getAnswer({ data: { projectId, observationId } }),
      retry: false,
    });

    const html = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client },
        createElement(AnswerContent, { projectId, observationId }),
      ),
    );

    expect(getAnswer).toHaveBeenCalledWith({
      data: { projectId, observationId },
    });
    expect(html).toContain("Could not load AI visibility");
    expect(html).not.toContain("private answer text");
    client.clear();
  });
});

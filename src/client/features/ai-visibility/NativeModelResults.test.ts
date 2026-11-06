import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AiNativeResult } from "@/shared/ai-visibility";
import { NativeModelResults } from "./NativeModelResults";

vi.mock("@/serverFunctions/ai-visibility", () => ({}));

const result: AiNativeResult = {
  id: "native-result",
  schemaVersion: 1,
  clientId: "client",
  projectId: "project",
  runId: "run",
  questionId: "question",
  questionVersion: 3,
  question: "Original question text?",
  requestedModel: "model-a",
  observedModel: "model-a-reported",
  route: "codex_cli",
  resultStatus: "completed",
  answer: "Saved answer text.",
  searchStatus: "unknown",
  searchEvidence: [
    { tool: "web_search", status: "unknown", evidenceRef: "event-1" },
  ],
  searchSources: ["https://search.example/page"],
  sources: ["https://answer.example/page"],
  eligibleForVisibility: null,
  errorCode: null,
  turnStatus: null,
  collectedAt: "2026-10-01T12:00:00.000Z",
};

describe("native model result display", () => {
  it("shows model, route, question version, answer, search status, and evidence", () => {
    const html = renderToStaticMarkup(
      createElement(NativeModelResults, { results: [result] }),
    );

    expect(html).toContain("model-a");
    expect(html).toContain("model-a-reported");
    expect(html).toContain("codex_cli");
    expect(html).toContain("v3");
    expect(html).toContain("Original question text?");
    expect(html).toContain("Saved answer text.");
    expect(html).toContain("Search: unknown");
    expect(html).toContain("event-1");
  });
});

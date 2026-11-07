import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SelectedRunBoundary } from "./SelectedRunBoundary";

vi.mock("./shared", () => ({
  AiQueryError: () =>
    createElement("div", null, "Could not load AI visibility"),
}));

describe("selected run boundary", () => {
  it("does not fall through to report content when a selected run is unavailable", () => {
    const html = renderToStaticMarkup(
      createElement(
        SelectedRunBoundary,
        {
          runId: "foreign-run-id",
          error: Object.assign(new Error("Not found"), { code: "NOT_FOUND" }),
          retry: vi.fn(),
        },
        createElement("p", null, "Private run answer"),
      ),
    );

    expect(html).not.toContain("Private run answer");
    expect(html).toContain("Could not load AI visibility");
  });
});

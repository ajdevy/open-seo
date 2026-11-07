import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProjectAccessBoundary } from "./ProjectAccessBoundary";

describe("project access boundary", () => {
  it("does not render project content before access succeeds", () => {
    const html = renderToStaticMarkup(
      createElement(ProjectAccessBoundary, {
        allowed: false,
        children: createElement("p", null, "Private project report"),
      }),
    );

    expect(html).toContain("Checking project access");
    expect(html).not.toContain("Private project report");
  });

  it("renders project content after access succeeds", () => {
    const html = renderToStaticMarkup(
      createElement(ProjectAccessBoundary, {
        allowed: true,
        children: createElement("p", null, "Allowed project report"),
      }),
    );

    expect(html).toContain("Allowed project report");
  });
});

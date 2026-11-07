import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProjectAccessBoundary } from "./ProjectAccessBoundary";

describe("project access boundary", () => {
  it("does not render project content before access succeeds", () => {
    const html = renderToStaticMarkup(
      createElement(
        ProjectAccessBoundary,
        {
          canCheckAccess: true,
          access: { isSuccess: false, isFetchedAfterMount: false },
        },
        createElement("p", null, "Private project report"),
      ),
    );

    expect(html).toContain("Checking project access");
    expect(html).not.toContain("Private project report");
  });

  it("renders project content after access succeeds", () => {
    const html = renderToStaticMarkup(
      createElement(
        ProjectAccessBoundary,
        {
          canCheckAccess: true,
          access: { isSuccess: true, isFetchedAfterMount: true },
        },
        createElement("p", null, "Allowed project report"),
      ),
    );

    expect(html).toContain("Allowed project report");
  });

  it("hides cached project content until this visit rechecks access", () => {
    const html = renderToStaticMarkup(
      createElement(
        ProjectAccessBoundary,
        {
          canCheckAccess: true,
          access: { isSuccess: true, isFetchedAfterMount: false },
        },
        createElement("p", null, "Cached private project report"),
      ),
    );

    expect(html).toContain("Checking project access");
    expect(html).not.toContain("Cached private project report");
  });
});

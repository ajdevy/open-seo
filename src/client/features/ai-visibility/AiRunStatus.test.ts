import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AiRunStatus } from "./shared";

vi.mock("@/serverFunctions/ai-visibility", () => ({}));

const run = {
  id: "00000000-0000-4000-8000-000000000201",
  trigger: "manual" as const,
  expected: 3,
  completed: 1,
  failed: 1,
  pending: 1,
  createdAt: "2026-11-07T12:00:00.000Z",
  completedAt: null,
  pollAfterSeconds: 5,
};

describe("AI run status display", () => {
  it("shows active progress and counts", () => {
    const html = renderToStaticMarkup(
      createElement(AiRunStatus, {
        run: { ...run, status: "running" },
      }),
    );

    expect(html).toContain("running");
    expect(html).toContain("1 of 3 answers collected");
    expect(html).toContain("1 pending");
    expect(html).toContain("1 failed");
    expect(html).toContain('role="progressbar"');
  });

  it.each(["partial", "completed", "failed"] as const)(
    "shows the terminal %s state and its task counts",
    (status) => {
      const html = renderToStaticMarkup(
        createElement(AiRunStatus, {
          run: { ...run, status, completedAt: "2026-11-07T12:01:00.000Z" },
        }),
      );

      expect(html).toContain(status);
      expect(html).toContain("1 of 3 answers collected");
      expect(html).toContain("1 pending");
      expect(html).toContain("1 failed");
    },
  );
});

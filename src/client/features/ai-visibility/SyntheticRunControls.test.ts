import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SyntheticRunControls } from "./SyntheticRunControls";

vi.mock("./shared", () => ({ aiDate: () => "Recent run" }));

const projectRun = {
  id: "00000000-0000-4000-8000-000000000201",
  status: "running" as const,
  trigger: "manual" as const,
  expected: 2,
  completed: 1,
  failed: 0,
  pending: 1,
  createdAt: "2026-11-07T12:00:00.000Z",
  completedAt: null,
  pollAfterSeconds: 5,
};

describe("synthetic run controls", () => {
  it("selects a project run and only creates after explicit form submission", () => {
    const onCreate = vi.fn();
    const html = renderToStaticMarkup(
      createElement(SyntheticRunControls, {
        prompts: [
          {
            id: "00000000-0000-4000-8000-000000000101",
            text: "Which tools should a team use?",
            topic: "Research",
            paused: false,
            archived: false,
            branded: false,
            hasResults: false,
          },
        ],
        recentRuns: [projectRun],
        runId: projectRun.id,
        creating: false,
        onSelectRunId: vi.fn(),
        onCreate,
      }),
    );

    expect(html).toContain("Select AI visibility run");
    expect(html).toContain(projectRun.id);
    expect(html).toContain("Creates 1 pending task");
    expect(html).toContain("Creating tasks does not call a model or provider.");
    expect(html).toContain("Create synthetic run");
    expect(onCreate).not.toHaveBeenCalled();
  });
});

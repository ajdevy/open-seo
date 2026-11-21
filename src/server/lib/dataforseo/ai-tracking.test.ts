import { beforeEach, describe, expect, it, vi } from "vitest";

const dataforseoCore = vi.hoisted(() => ({
  dataforseoGet: vi.fn(),
  dataforseoPost: vi.fn(),
}));

vi.mock("@/server/lib/dataforseo/core", () => dataforseoCore);

import {
  fetchAiTrackingLiveAnswer,
  postAiTrackingTasks,
} from "@/server/lib/dataforseo/ai-tracking";

const input = {
  engine: "chatgpt" as const,
  locationCode: 2840,
  languageCode: "en",
  tasks: [
    { tag: "submitted-a", prompt: "prompt a" },
    { tag: "submitted-b", prompt: "prompt b" },
  ],
};

function entry(tag: string, cost?: number, statusCode = 20100) {
  return {
    status_code: statusCode,
    id: `task-${tag}`,
    ...(cost === undefined ? {} : { cost }),
    data: { tag },
  };
}

describe("AI tracking provider cost metadata", () => {
  beforeEach(() => {
    dataforseoCore.dataforseoGet.mockResolvedValue({
      status_code: 20000,
      tasks: [],
    });
    dataforseoCore.dataforseoPost.mockResolvedValue({
      status_code: 20000,
      tasks: [],
    });
  });

  it("does not report a queued task post with missing cost as known zero", async () => {
    dataforseoCore.dataforseoPost.mockResolvedValue({
      status_code: 20000,
      tasks: [entry("submitted-a")],
    });

    const response = await postAiTrackingTasks({
      ...input,
      tasks: [input.tasks[0]],
    });

    expect(response.billing).toMatchObject({ costUsd: 0, costKnown: false });
  });

  it("keeps an exact zero queued cost known", async () => {
    dataforseoCore.dataforseoPost.mockResolvedValue({
      status_code: 20000,
      tasks: [entry("submitted-a", 0)],
    });

    const response = await postAiTrackingTasks({
      ...input,
      tasks: [input.tasks[0]],
    });

    expect(response.billing).toMatchObject({ costUsd: 0, costKnown: true });
  });

  it("does not report a live answer with missing cost as known zero", async () => {
    dataforseoCore.dataforseoPost.mockResolvedValue({
      status_code: 20000,
      tasks: [
        {
          status_code: 20000,
          result: [{ markdown: "OpenSEO" }],
        },
      ],
    });

    const response = await fetchAiTrackingLiveAnswer({
      engine: "chatgpt",
      locationCode: 2840,
      languageCode: "en",
      task: { tag: "answer-a", prompt: "Which SEO tools?" },
    });

    expect(response.billing).toMatchObject({ costUsd: 0, costKnown: false });
  });

  it("marks queued cost known only when raw entries cover submitted tags once", async () => {
    dataforseoCore.dataforseoPost.mockResolvedValue({
      status_code: 20000,
      tasks: [entry("submitted-a", 0.01), entry("submitted-b", 0.02)],
    });

    const response = await postAiTrackingTasks(input);

    expect(response.data).toHaveLength(2);
    expect(response.billing).toMatchObject({ costUsd: 0.03, costKnown: true });
  });

  it("counts extra rejected raw entries when deciding cost coverage", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    dataforseoCore.dataforseoPost.mockResolvedValue({
      status_code: 20000,
      tasks: [
        entry("submitted-a", 0.01),
        entry("submitted-b", 0.02),
        entry("unexpected", 0.03, 40000),
      ],
    });

    try {
      const response = await postAiTrackingTasks(input);
      expect(response.data).toHaveLength(2);
      expect(response.billing).toMatchObject({
        costUsd: 0.06,
        costKnown: false,
      });
    } finally {
      warn.mockRestore();
    }
  });

  it("marks cost unknown when provider tags are duplicated", async () => {
    dataforseoCore.dataforseoPost.mockResolvedValue({
      status_code: 20000,
      tasks: [entry("submitted-a", 0.01), entry("submitted-a", 0.02)],
    });
    const result = await postAiTrackingTasks(input);

    expect(result.billing.costKnown).toBe(false);
  });

  it("marks cost unknown when a submitted tag is missing", async () => {
    dataforseoCore.dataforseoPost.mockResolvedValue({
      status_code: 20000,
      tasks: [entry("submitted-a", 0.01)],
    });
    const result = await postAiTrackingTasks(input);

    expect(result.billing.costKnown).toBe(false);
  });
});

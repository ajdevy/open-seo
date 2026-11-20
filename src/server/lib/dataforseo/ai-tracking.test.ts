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

describe("AI tracking provider cost metadata", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("does not report a queued task post with missing cost as known zero", async () => {
    dataforseoCore.dataforseoPost.mockResolvedValue({
      status_code: 20000,
      tasks: [
        {
          status_code: 20100,
          id: "task-a",
          data: { tag: "answer-a" },
        },
      ],
    });

    const response = await postAiTrackingTasks({
      engine: "chatgpt",
      locationCode: 2840,
      languageCode: "en",
      tasks: [{ tag: "answer-a", prompt: "Which SEO tools?" }],
    });

    expect(response.billing).toMatchObject({
      costUsd: 0,
      costKnown: false,
    });
  });

  it("keeps an exact zero queued cost known", async () => {
    dataforseoCore.dataforseoPost.mockResolvedValue({
      status_code: 20000,
      tasks: [
        {
          status_code: 20100,
          id: "task-a",
          cost: 0,
          data: { tag: "answer-a" },
        },
      ],
    });

    const response = await postAiTrackingTasks({
      engine: "chatgpt",
      locationCode: 2840,
      languageCode: "en",
      tasks: [{ tag: "answer-a", prompt: "Which SEO tools?" }],
    });

    expect(response.billing).toMatchObject({
      costUsd: 0,
      costKnown: true,
    });
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

    expect(response.billing).toMatchObject({
      costUsd: 0,
      costKnown: false,
    });
  });
});

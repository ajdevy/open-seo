import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import {
  clearQueryCacheForUserChange,
  queryCacheMatchesUser,
} from "./userScopedQueryCache";

describe("user-scoped query cache", () => {
  it("clears cached project data before another user can render", () => {
    const client = new QueryClient();
    client.setQueryData(["aiVisibility", "project-a", "tracker"], {
      privatePrompt: "User A prompt",
    });

    clearQueryCacheForUserChange(client, "user-a", "user-b");

    expect(client.getQueryData(["aiVisibility", "project-a", "tracker"])).toBe(
      undefined,
    );
    expect(queryCacheMatchesUser("user-a", "user-b")).toBe(false);
    expect(queryCacheMatchesUser("user-b", "user-b")).toBe(true);
    client.clear();
  });

  it("starts closed until the initial session cache has been cleared", () => {
    expect(queryCacheMatchesUser(undefined, "user-a")).toBe(false);
    expect(queryCacheMatchesUser(null, "user-a")).toBe(false);
  });
});

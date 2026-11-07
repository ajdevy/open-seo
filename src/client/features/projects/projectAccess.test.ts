import { describe, expect, it } from "vitest";
import { projectAccessQueryKey } from "./projectAccess";

describe("project access query scope", () => {
  it("does not reuse an access decision across users or projects", () => {
    expect(projectAccessQueryKey("user-a", "project-a")).not.toEqual(
      projectAccessQueryKey("user-b", "project-a"),
    );
    expect(projectAccessQueryKey("user-a", "project-a")).not.toEqual(
      projectAccessQueryKey("user-a", "project-b"),
    );
  });
});

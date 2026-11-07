import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { ProjectAccessBoundary } from "./ProjectAccessBoundary";
import {
  hasConfirmedProjectAccess,
  projectAccessQueryKey,
  projectAccessQueryOptions,
} from "./projectAccess";

describe("project access query scope", () => {
  it("does not reuse an access decision across users or projects", () => {
    expect(projectAccessQueryKey("user-a", "project-a")).not.toEqual(
      projectAccessQueryKey("user-b", "project-a"),
    );
    expect(projectAccessQueryKey("user-a", "project-a")).not.toEqual(
      projectAccessQueryKey("user-a", "project-b"),
    );
  });

  it("rechecks a cached same-user project before rendering after access is revoked", async () => {
    const queryClient = new QueryClient();
    const userId = "user-a";
    const projectId = "project-a";
    let revoked = false;
    let rejectAccessCheck!: (error: Error) => void;
    const pendingRevokedCheck = new Promise<never>((_resolve, reject) => {
      rejectAccessCheck = reject;
    });
    const getAccess = vi.fn(() =>
      revoked ? pendingRevokedCheck : Promise.resolve({ projectId }),
    );
    const options = projectAccessQueryOptions(userId, projectId, getAccess);
    let unsubscribeReselectedProject: (() => void) | undefined;

    try {
      await queryClient.fetchQuery(options);
      expect(getAccess).toHaveBeenCalledTimes(1);
      expect(queryClient.getQueryData(options.queryKey)).toEqual({ projectId });

      revoked = true;
      const reselectedProject = new QueryObserver(queryClient, options);
      const revokedCheck = new Promise<
        ReturnType<typeof reselectedProject.getCurrentResult>
      >((resolve) => {
        unsubscribeReselectedProject = reselectedProject.subscribe((result) => {
          if (result.isError) resolve(result);
        });
      });

      const cachedAccessDuringRecheck = reselectedProject.getCurrentResult();
      expect(getAccess).toHaveBeenCalledTimes(2);
      expect(cachedAccessDuringRecheck.data).toEqual({ projectId });
      expect(cachedAccessDuringRecheck.isFetching).toBe(true);
      expect(hasConfirmedProjectAccess(cachedAccessDuringRecheck)).toBe(false);

      const authorizedProjectQuery = vi.fn();
      function PrivateProjectPage() {
        authorizedProjectQuery();
        return createElement("p", null, "Private project content");
      }
      const html = renderToStaticMarkup(
        createElement(
          ProjectAccessBoundary,
          {
            canCheckAccess: true,
            access: cachedAccessDuringRecheck,
          },
          createElement(PrivateProjectPage),
        ),
      );
      expect(html).toContain("Checking project access");
      expect(html).not.toContain("Private project content");
      expect(authorizedProjectQuery).not.toHaveBeenCalled();

      rejectAccessCheck(new Error("Project access revoked"));
      const deniedAccess = await revokedCheck;
      expect(deniedAccess.isError).toBe(true);
      expect(hasConfirmedProjectAccess(deniedAccess)).toBe(false);
      expect(authorizedProjectQuery).not.toHaveBeenCalled();
    } finally {
      rejectAccessCheck(new Error("Test cleanup"));
      unsubscribeReselectedProject?.();
      queryClient.clear();
    }
  });
});

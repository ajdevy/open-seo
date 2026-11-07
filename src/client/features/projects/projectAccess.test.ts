import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { ProjectAccessBoundary } from "./ProjectAccessBoundary";
import {
  hasConfirmedProjectAccess,
  hasFreshProjectAccessError,
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

  it("waits for a fresh access result before redirecting a cached denial", async () => {
    const queryClient = new QueryClient();
    const userId = "user-a";
    const projectId = "project-a";
    let accessMode: "allowed" | "denied" | "restoring" = "allowed";
    let resolveRestoredAccess!: (value: { projectId: string }) => void;
    const getAccess = vi.fn((): Promise<{ projectId: string }> => {
      if (accessMode === "allowed") return Promise.resolve({ projectId });
      if (accessMode === "denied") {
        return Promise.reject(new Error("Project access denied"));
      }
      return new Promise((resolve) => {
        resolveRestoredAccess = resolve;
      });
    });
    const options = projectAccessQueryOptions(userId, projectId, getAccess);
    let unsubscribeDeniedProject: (() => void) | undefined;
    let unsubscribeRestoredProject: (() => void) | undefined;

    try {
      await queryClient.fetchQuery(options);
      expect(queryClient.getQueryData(options.queryKey)).toEqual({ projectId });

      accessMode = "denied";
      const deniedProject = new QueryObserver(queryClient, options);
      const cachedDenial = new Promise<
        ReturnType<typeof deniedProject.getCurrentResult>
      >((resolve) => {
        unsubscribeDeniedProject = deniedProject.subscribe((result) => {
          if (result.isError && !result.isFetching) resolve(result);
        });
      });
      const deniedAccess = await cachedDenial;
      expect(deniedAccess.data).toEqual({ projectId });
      expect(deniedAccess.isError).toBe(true);
      expect(hasFreshProjectAccessError(deniedAccess)).toBe(true);
      unsubscribeDeniedProject?.();
      unsubscribeDeniedProject = undefined;

      accessMode = "restoring";
      const restoredProject = new QueryObserver(queryClient, options);
      const freshSuccess = new Promise<
        ReturnType<typeof restoredProject.getCurrentResult>
      >((resolve) => {
        unsubscribeRestoredProject = restoredProject.subscribe((result) => {
          if (result.isSuccess && result.isFetchedAfterMount) resolve(result);
        });
      });

      const cachedDenialDuringRecheck = restoredProject.getCurrentResult();
      expect(getAccess).toHaveBeenCalledTimes(3);
      expect(cachedDenialDuringRecheck.isError).toBe(true);
      expect(cachedDenialDuringRecheck.isFetching).toBe(true);
      expect(cachedDenialDuringRecheck.isFetchedAfterMount).toBe(false);
      expect(hasFreshProjectAccessError(cachedDenialDuringRecheck)).toBe(false);
      expect(hasConfirmedProjectAccess(cachedDenialDuringRecheck)).toBe(false);
      expect(cachedDenialDuringRecheck.data).toEqual({ projectId });

      const authorizedProjectQuery = vi.fn();
      function PrivateProjectPage() {
        authorizedProjectQuery();
        return createElement("p", null, "Private project content");
      }
      const pendingHtml = renderToStaticMarkup(
        createElement(
          ProjectAccessBoundary,
          {
            canCheckAccess: true,
            access: cachedDenialDuringRecheck,
          },
          createElement(PrivateProjectPage),
        ),
      );
      expect(pendingHtml).toContain("Checking project access");
      expect(pendingHtml).not.toContain("Private project content");
      expect(authorizedProjectQuery).not.toHaveBeenCalled();

      resolveRestoredAccess({ projectId });
      const restoredAccess = await freshSuccess;
      expect(restoredAccess.isSuccess).toBe(true);
      expect(hasFreshProjectAccessError(restoredAccess)).toBe(false);
      expect(hasConfirmedProjectAccess(restoredAccess)).toBe(true);

      const authorizedHtml = renderToStaticMarkup(
        createElement(
          ProjectAccessBoundary,
          { canCheckAccess: true, access: restoredAccess },
          createElement(PrivateProjectPage),
        ),
      );
      expect(authorizedHtml).toContain("Private project content");
      expect(authorizedProjectQuery).toHaveBeenCalledTimes(1);
    } finally {
      resolveRestoredAccess?.({ projectId });
      unsubscribeDeniedProject?.();
      unsubscribeRestoredProject?.();
      queryClient.clear();
    }
  });
});

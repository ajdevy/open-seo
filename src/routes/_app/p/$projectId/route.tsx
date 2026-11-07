import {
  Outlet,
  createFileRoute,
  useMatch,
  useNavigate,
} from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import {
  clearLastProjectId,
  getLastProjectId,
  setLastProjectId,
} from "@/client/lib/active-project";
import { getErrorCode } from "@/client/lib/error-messages";
import {
  getCurrentAuthRedirectFromHref,
  getSignInSearch,
} from "@/lib/auth-redirect";
import { getProjectAccess } from "@/serverFunctions/projects";
import { useSession } from "@/lib/auth-client";
import { usesBetterAuthClient } from "@/lib/auth-mode";
import { ProjectAccessBoundary } from "@/client/features/projects/ProjectAccessBoundary";
import {
  hasConfirmedProjectAccess,
  hasFreshProjectAccessError,
  projectAccessQueryOptions,
} from "@/client/features/projects/projectAccess";

export const Route = createFileRoute("/_app/p/$projectId")({
  // Everything under this subtree fetches its data client-side with
  // react-query, so SSR would only render empty chrome.
  ssr: false,
  component: ProjectLayout,
});

// Redirect-only guard, deliberately NOT a blocking beforeLoad: the shell
// renders immediately while the access check runs in the background, and the
// browser only gets bounced if it lands on a project it can't see (stale
// last-project id, foreign URL). Real authorization is enforced on every data
// call; nothing sensitive renders from this check.
function useProjectAccessRedirect(projectId: string) {
  const navigate = useNavigate();
  const { data: session, isPending: sessionPending } = useSession();
  const hasAccounts = usesBetterAuthClient();
  const userId = session?.user?.id ?? null;
  const canCheckAccess = Boolean(
    !sessionPending && (!hasAccounts || Boolean(userId)),
  );
  const access = useQuery({
    ...projectAccessQueryOptions(userId, projectId, () =>
      getProjectAccess({ data: { projectId } }),
    ),
    enabled: canCheckAccess,
  });
  const error = access.error;
  const hasFreshError = hasFreshProjectAccessError(access);
  useEffect(() => {
    if (!canCheckAccess || !error || !hasFreshError) return;
    if (getErrorCode(error) === "UNAUTHENTICATED") {
      void navigate({
        to: "/sign-in",
        search: getSignInSearch(
          getCurrentAuthRedirectFromHref(window.location.href),
        ),
        replace: true,
      });
      return;
    }
    // Forget it if it's the remembered project, or the landing redirect
    // would bring the user straight back here.
    if (getLastProjectId() === projectId) clearLastProjectId();
    void navigate({ to: "/", replace: true });
  }, [canCheckAccess, error, hasFreshError, navigate, projectId]);
  return { canCheckAccess, access };
}

function ProjectLayout() {
  const { projectId } = Route.useParams();
  const { canCheckAccess, access } = useProjectAccessRedirect(projectId);
  const hasAccess = canCheckAccess && hasConfirmedProjectAccess(access);

  // Remember this as the last-visited project for the landing redirect, once
  // the access check confirms it's one of the org's projects.
  // Settings and its sub-pages are excluded: editing another project's
  // settings is administration, not a context switch, so it shouldn't change
  // which project the app opens next time. (An explicit choice still counts:
  // the switcher and project creation set it themselves, settings page or not.)
  const isSettingsPage =
    useMatch({
      from: "/_app/p/$projectId/settings",
      shouldThrow: false,
      select: () => true,
    }) ?? false;
  useEffect(() => {
    if (!hasAccess || isSettingsPage) return;
    setLastProjectId(projectId);
  }, [projectId, hasAccess, isSettingsPage]);

  return (
    <ProjectAccessBoundary canCheckAccess={canCheckAccess} access={access}>
      <Outlet />
    </ProjectAccessBoundary>
  );
}

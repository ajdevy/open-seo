import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSession } from "@/lib/auth-client";
import {
  isEmailVerificationBypassed,
  isHostedClientAuthMode,
  usesBetterAuthClient,
} from "@/lib/auth-mode";
import {
  clearQueryCacheForUserChange,
  queryCacheMatchesUser,
} from "./userScopedQueryCache";
import {
  getCurrentAuthRedirectFromHref,
  getSignInSearch,
  getVerifyEmailSearch,
} from "@/lib/auth-redirect";

export function useHostedAuthRouteGuard() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: session, isPending } = useSession();
  // The session guard runs wherever Better Auth accounts exist (hosted and the
  // standalone Docker edition); isHostedMode is kept for callers that gate
  // hosted-only surfaces such as billing.
  const isHostedMode = isHostedClientAuthMode();
  const hasAccounts = usesBetterAuthClient();
  const emailVerified =
    session?.user?.emailVerified === true || isEmailVerificationBypassed();
  const userId = hasAccounts ? (session?.user?.id ?? null) : null;
  const [cacheUserId, setCacheUserId] = useState<string | null | undefined>(
    undefined,
  );

  // Project query keys are scoped by project ID. Clear the in-memory cache
  // when the authenticated user changes, before allowing the next user's UI
  // to render, so a reused project ID cannot show the prior user's data.
  useEffect(() => {
    if (isPending || queryCacheMatchesUser(cacheUserId, userId)) return;
    clearQueryCacheForUserChange(queryClient, cacheUserId, userId);
    setCacheUserId(userId);
  }, [cacheUserId, isPending, queryClient, userId]);

  useEffect(() => {
    if (isPending || !hasAccounts) {
      return;
    }

    const redirectTo = getCurrentAuthRedirectFromHref(window.location.href);

    if (!session?.user?.id) {
      void navigate({
        to: "/sign-in",
        search: getSignInSearch(redirectTo),
        replace: true,
      });
      return;
    }

    if (!emailVerified) {
      void navigate({
        to: "/verify-email",
        search: getVerifyEmailSearch(session.user.email, redirectTo),
        replace: true,
      });
    }
  }, [
    isPending,
    hasAccounts,
    emailVerified,
    session?.user?.email,
    session?.user?.id,
    navigate,
  ]);

  const hasVerifiedSession =
    !isPending &&
    Boolean(session?.user?.id) &&
    emailVerified &&
    queryCacheMatchesUser(cacheUserId, userId);

  return {
    isHostedMode,
    canRenderAuthenticatedContent: !hasAccounts || hasVerifiedSession,
  };
}

import type { QueryClient } from "@tanstack/react-query";

export type QueryCacheUserId = string | null;

/** A signed-in user's query cache must never be reused by a different user. */
export function clearQueryCacheForUserChange(
  queryClient: QueryClient,
  previousUserId: QueryCacheUserId | undefined,
  nextUserId: QueryCacheUserId,
) {
  if (previousUserId !== nextUserId) queryClient.clear();
}

export function queryCacheMatchesUser(
  cachedUserId: QueryCacheUserId | undefined,
  userId: QueryCacheUserId,
) {
  return cachedUserId !== undefined && cachedUserId === userId;
}

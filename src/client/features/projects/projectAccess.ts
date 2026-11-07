export function projectAccessQueryKey(
  userId: string | null,
  projectId: string,
) {
  return ["projectAccess", userId ?? "local", projectId] as const;
}

export function projectAccessQueryOptions(
  userId: string | null,
  projectId: string,
  queryFn: () => Promise<unknown>,
) {
  return {
    queryKey: projectAccessQueryKey(userId, projectId),
    queryFn,
    retry: false,
    staleTime: 0,
    refetchOnMount: "always" as const,
  };
}

export function hasConfirmedProjectAccess(access: {
  isSuccess: boolean;
  isFetchedAfterMount: boolean;
}) {
  return access.isSuccess && access.isFetchedAfterMount;
}

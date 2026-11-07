export function projectAccessQueryKey(
  userId: string | null,
  projectId: string,
) {
  return ["projectAccess", userId ?? "local", projectId] as const;
}

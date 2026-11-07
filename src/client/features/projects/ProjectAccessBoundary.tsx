import type { ReactNode } from "react";
import { hasConfirmedProjectAccess } from "./projectAccess";

/** Keeps project pages and their cached child data off screen until access is confirmed. */
export function ProjectAccessBoundary({
  canCheckAccess,
  access,
  children,
}: {
  canCheckAccess: boolean;
  access: {
    isSuccess: boolean;
    isFetchedAfterMount: boolean;
  };
  children?: ReactNode;
}) {
  if (!canCheckAccess || !hasConfirmedProjectAccess(access)) {
    return (
      <div
        className="flex min-h-40 items-center justify-center text-sm text-muted-foreground"
        role="status"
      >
        Checking project access…
      </div>
    );
  }
  return children;
}

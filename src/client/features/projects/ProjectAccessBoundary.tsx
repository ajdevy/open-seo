import type { ReactNode } from "react";

/** Keeps project pages and their cached child data off screen until access is confirmed. */
export function ProjectAccessBoundary({
  allowed,
  children,
}: {
  allowed: boolean;
  children?: ReactNode;
}) {
  if (!allowed) {
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

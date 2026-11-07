import type { ReactNode } from "react";
import { AiQueryError } from "./shared";

/** A failed selected run must not fall through to another run's report. */
export function SelectedRunBoundary({
  runId,
  error,
  retry,
  children,
}: {
  runId: string | undefined;
  error: Error | null;
  retry: () => void;
  children?: ReactNode;
}) {
  if (runId && error) return <AiQueryError error={error} retry={retry} />;
  return children ?? null;
}

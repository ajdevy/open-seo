import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/client/components/ui/alert";
import type { AiTrackerState } from "@/shared/ai-visibility";

export function ProjectSettingsSnapshotNotice({
  snapshot,
}: {
  snapshot: AiTrackerState["settingsSnapshot"];
}) {
  if (!snapshot) return null;

  if (snapshot.status === "confirmed")
    return (
      <Alert variant="success" role="status">
        <AlertTitle>Settings snapshot archived</AlertTitle>
        <AlertDescription>
          The latest project settings snapshot is confirmed in the remote
          archive and recoverable after server loss.
        </AlertDescription>
      </Alert>
    );

  if (snapshot.status === "unconfirmed")
    return (
      <Alert variant="warning" role="status">
        <AlertTitle>Settings snapshot pending archive confirmation</AlertTitle>
        <AlertDescription>
          The latest snapshot is queued, but is not recoverable after server
          loss until the archive confirms it.
        </AlertDescription>
      </Alert>
    );

  return (
    <Alert variant="warning" role="status">
      <AlertTitle>No settings snapshot archived</AlertTitle>
      <AlertDescription>
        No project settings snapshot is available yet; the current settings are
        not recoverable after server loss.
      </AlertDescription>
    </Alert>
  );
}

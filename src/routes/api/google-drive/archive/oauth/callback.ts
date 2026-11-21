import { createFileRoute } from "@tanstack/react-router";
import { handleGoogleDriveArchiveOAuthCallback } from "@/server/features/project-settings-snapshots/googleDriveArchiveOAuthCallback";

export const Route = createFileRoute(
  "/api/google-drive/archive/oauth/callback",
)({
  server: {
    handlers: {
      GET: async ({ request }: { request: Request }) =>
        handleGoogleDriveArchiveOAuthCallback(request),
    },
  },
});

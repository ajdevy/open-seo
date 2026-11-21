import { z } from "zod";
import {
  GOOGLE_DRIVE_ABOUT_URL,
  REQUEST_TIMEOUT_MS,
} from "./googleDriveArchiveOAuthShared";

const driveAboutResponseSchema = z.object({
  user: z.object({
    permissionId: z.string().min(1),
    emailAddress: z.string().email().nullable().optional(),
    me: z.boolean(),
  }),
});

export async function getGoogleDriveAccountIdentity(accessToken: string) {
  const url = new URL(GOOGLE_DRIVE_ABOUT_URL);
  url.searchParams.set("fields", "user(permissionId,emailAddress,me)");
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error("Google Drive account lookup failed.");
  const about = driveAboutResponseSchema.parse(await response.json());
  if (!about.user.me)
    throw new Error("Google Drive account does not identify the current user.");
  return {
    googleAccountId: about.user.permissionId,
    accountEmail: about.user.emailAddress ?? null,
  };
}

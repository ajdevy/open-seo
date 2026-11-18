import { expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ env: { DATABASE_PROVIDER: "d1" } }));

import {
  googleDriveTokenContext,
  tokenCipher,
  type DriveArchiveConfig,
} from "./googleDriveArchiveOAuthShared";

const config: DriveArchiveConfig = {
  clientId: "synthetic-client-id.apps.googleusercontent.com",
  clientSecret: "synthetic-oauth-client-secret",
  tokenKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  redirectUri:
    "https://autogeo.flexsentlabs.com/api/google-drive/archive/oauth/callback",
  pickerApiKey: "synthetic-picker-key",
  projectNumber: "123456789",
};

it("binds encrypted tokens to OAuth client, workspace, account, and purpose", async () => {
  const cipher = await tokenCipher(config);
  const context = googleDriveTokenContext(
    config,
    "organization",
    "google-account-1",
    "refresh",
  );
  const encrypted = await cipher.encrypt("synthetic-refresh-token", context);

  expect(encrypted).toMatch(/^v2\./u);
  await expect(cipher.decrypt(encrypted, context)).resolves.toBe(
    "synthetic-refresh-token",
  );
  for (const mismatchedContext of [
    googleDriveTokenContext(
      config,
      "another-organization",
      "google-account-1",
      "refresh",
    ),
    googleDriveTokenContext(
      config,
      "organization",
      "another-google-account",
      "refresh",
    ),
    googleDriveTokenContext(
      config,
      "organization",
      "google-account-1",
      "access",
    ),
  ])
    await expect(
      cipher.decrypt(encrypted, mismatchedContext),
    ).rejects.toThrow();
});

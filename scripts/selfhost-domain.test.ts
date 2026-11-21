import { expect, it } from "vitest";
import * as selfHostAccess from "../deploy/alchemy/alchemy.selfhost";
import {
  appDomains,
  resolveSelfHostAccessHostname,
  resolveSelfHostDomain,
  resolveSelfHostPublicUrl,
  selfHostArchiveEnvForStage,
} from "../deploy/alchemy/alchemy.selfhost";

it("accepts a normalized public custom host only for the self-host stage", () => {
  expect(resolveSelfHostDomain("selfhost", " AutoGeo.Flexsentlabs.com ")).toBe(
    "autogeo.flexsentlabs.com",
  );
  expect(resolveSelfHostDomain("preview-123", "autogeo.flexsentlabs.com")).toBe(
    undefined,
  );
});

it("rejects URL syntax, paths, and malformed hostnames for a custom host", () => {
  for (const value of [
    "https://autogeo.flexsentlabs.com",
    "autogeo.flexsentlabs.com/path",
    "autogeo..flexsentlabs.com",
    "autogeo_flexsentlabs.com",
  ]) {
    expect(() => resolveSelfHostDomain("selfhost", value)).toThrow(
      "SELFHOST_CUSTOM_DOMAIN must be a bare public DNS hostname.",
    );
  }
});

it("keeps hosted production domains fixed and routes self-host Access through its custom host", () => {
  expect(appDomains("hosted-prod", "autogeo.flexsentlabs.com")).toEqual([
    "app.openseo.so",
    "www.app.openseo.so",
  ]);
  expect(appDomains("selfhost", "autogeo.flexsentlabs.com")).toEqual([
    "autogeo.flexsentlabs.com",
  ]);
  expect(
    resolveSelfHostAccessHostname(
      "selfhost",
      "account.workers.dev",
      "autogeo.flexsentlabs.com",
    ),
  ).toBe("autogeo.flexsentlabs.com");
  expect(
    resolveSelfHostAccessHostname("preview-123", "account.workers.dev"),
  ).toBe("open-seo-preview-123.account.workers.dev");
  expect(resolveSelfHostPublicUrl("selfhost", "autogeo.flexsentlabs.com")).toBe(
    "https://autogeo.flexsentlabs.com",
  );
  expect(
    resolveSelfHostPublicUrl("preview-123", "autogeo.flexsentlabs.com"),
  ).toBe(undefined);
});

it("exposes archive OAuth bindings only to the self-host application Worker", () => {
  const archiveEnv = {
    GOOGLE_DRIVE_ARCHIVE_CLIENT_SECRET: "synthetic-secret",
    GOOGLE_DRIVE_ARCHIVE_TOKEN_KEY_B64: "synthetic-key",
  };

  expect(selfHostArchiveEnvForStage("selfhost", archiveEnv)).toEqual(
    archiveEnv,
  );
  expect(selfHostArchiveEnvForStage("hosted-prod", archiveEnv)).toEqual({});
  expect(selfHostArchiveEnvForStage("preview-123", archiveEnv)).toEqual({});
});

it("requires a custom-host archive redirect to use that HTTPS origin", () => {
  const validator = (
    selfHostAccess as unknown as {
      assertSelfHostArchiveRedirectOrigin?: (
        stage: string,
        customDomain: string | undefined,
        redirectUri: string | undefined,
      ) => void;
    }
  ).assertSelfHostArchiveRedirectOrigin;

  expect(validator).toBeTypeOf("function");
  if (!validator) return;

  expect(() =>
    validator(
      "selfhost",
      "autogeo.flexsentlabs.com",
      "https://seo.example.com/api/google-drive/archive/oauth/callback",
    ),
  ).toThrow(
    "GOOGLE_DRIVE_ARCHIVE_REDIRECT_URI must use https://autogeo.flexsentlabs.com.",
  );

  expect(() =>
    validator(
      "selfhost",
      "autogeo.flexsentlabs.com",
      "http://autogeo.flexsentlabs.com/api/google-drive/archive/oauth/callback",
    ),
  ).toThrow(
    "GOOGLE_DRIVE_ARCHIVE_REDIRECT_URI must use https://autogeo.flexsentlabs.com.",
  );

  expect(() =>
    validator(
      "selfhost",
      "autogeo.flexsentlabs.com",
      "https://autogeo.flexsentlabs.com/connect/google-workspace/callback",
    ),
  ).toThrow(
    "GOOGLE_DRIVE_ARCHIVE_REDIRECT_URI must use https://autogeo.flexsentlabs.com/api/google-drive/archive/oauth/callback without a query or fragment.",
  );

  expect(() =>
    validator(
      "selfhost",
      "autogeo.flexsentlabs.com",
      "https://autogeo.flexsentlabs.com/api/google-drive/archive/oauth/callback",
    ),
  ).not.toThrow();
});

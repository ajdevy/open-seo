import type * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as CfWorkers from "@distilled.cloud/cloudflare/workers";
import * as ZeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { emailAccessGate, requireAllowedEmails } from "./alchemy.access.ts";
import { HOSTED_PROD_STAGE, workerName } from "./alchemy.access.ts";

const PUBLIC_DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const GOOGLE_DRIVE_ARCHIVE_CALLBACK_PATH =
  "/api/google-drive/archive/oauth/callback";
const accessScopeHint =
  " (if this is a permissions error, re-run `pnpm alchemy login --configure`, answer yes to “Customize OAuth scopes?”, and select access:write alongside the defaults)";

/** A customer hostname is supported only by the fixed self-host stage. */
export const resolveSelfHostDomain = (
  stage: string,
  configuredDomain: string,
): string | undefined => {
  if (stage !== "selfhost" || !configuredDomain.trim()) return undefined;
  const domain = configuredDomain.trim().toLowerCase();
  const labels = domain.split(".");
  if (
    domain.length > 253 ||
    labels.length < 2 ||
    labels.some((label) => !PUBLIC_DNS_LABEL.test(label)) ||
    /^\d+$/u.test(labels.at(-1) ?? "")
  )
    throw new Error(
      "SELFHOST_CUSTOM_DOMAIN must be a bare public DNS hostname.",
    );
  return domain;
};

export const assertSelfHostArchiveRedirectOrigin = (
  stage: string,
  customDomain: string | undefined,
  redirectUri: string | undefined,
): void => {
  if (stage !== "selfhost" || !customDomain || !redirectUri?.trim()) return;

  let redirect: URL;
  try {
    redirect = new URL(redirectUri.trim());
  } catch {
    throw new Error(
      `GOOGLE_DRIVE_ARCHIVE_REDIRECT_URI must use https://${customDomain}.`,
    );
  }
  if (
    redirect.protocol !== "https:" ||
    redirect.origin !== `https://${customDomain}`
  )
    throw new Error(
      `GOOGLE_DRIVE_ARCHIVE_REDIRECT_URI must use https://${customDomain}.`,
    );
  if (
    redirect.pathname !== GOOGLE_DRIVE_ARCHIVE_CALLBACK_PATH ||
    redirect.search ||
    redirect.hash ||
    redirect.username ||
    redirect.password
  )
    throw new Error(
      `GOOGLE_DRIVE_ARCHIVE_REDIRECT_URI must use https://${customDomain}${GOOGLE_DRIVE_ARCHIVE_CALLBACK_PATH} without a query or fragment.`,
    );
};

export const readSelfHostSettings = (stage: string) =>
  Effect.gen(function* () {
    const domain = resolveSelfHostDomain(
      stage,
      yield* Config.string("SELFHOST_CUSTOM_DOMAIN").pipe(
        Config.withDefault(""),
      ),
    );
    assertSelfHostArchiveRedirectOrigin(
      stage,
      domain,
      yield* Config.string("GOOGLE_DRIVE_ARCHIVE_REDIRECT_URI").pipe(
        Config.withDefault(""),
      ),
    );
    return { domain, publicUrl: resolveSelfHostPublicUrl(stage, domain) };
  });

export const appDomains = (
  stage: string,
  selfHostDomain?: string,
): string[] | undefined => {
  if (stage === HOSTED_PROD_STAGE)
    return ["app.openseo.so", "www.app.openseo.so"];
  if (stage === "selfhost" && selfHostDomain) return [selfHostDomain];
  return undefined;
};

export const resolveSelfHostAccessHostname = (
  stage: string,
  workersSubdomain: string,
  selfHostDomain?: string,
) =>
  stage === "selfhost" && selfHostDomain
    ? selfHostDomain
    : `${workerName(stage)}.${workersSubdomain}`;

export const accessHostname = resolveSelfHostAccessHostname;

export const resolveSelfHostPublicUrl = (
  stage: string,
  selfHostDomain?: string,
) =>
  stage === "selfhost" && selfHostDomain
    ? `https://${selfHostDomain}`
    : undefined;

export const selfHostArchiveEnvForStage = <T extends Record<string, unknown>>(
  stage: string,
  archiveEnv: T,
): Partial<T> => (stage === "selfhost" ? archiveEnv : {});

export const archiveEnvForStage = selfHostArchiveEnvForStage;

export const createArchiveEnv = <TVar, TSecret>(
  optionalVar: (name: string) => TVar,
  optionalSecret: (name: string) => TSecret,
) => ({
  GOOGLE_DRIVE_ARCHIVE_CLIENT_ID: optionalVar("GOOGLE_DRIVE_ARCHIVE_CLIENT_ID"),
  GOOGLE_DRIVE_ARCHIVE_CLIENT_SECRET: optionalSecret(
    "GOOGLE_DRIVE_ARCHIVE_CLIENT_SECRET",
  ),
  GOOGLE_DRIVE_ARCHIVE_TOKEN_KEY_B64: optionalSecret(
    "GOOGLE_DRIVE_ARCHIVE_TOKEN_KEY_B64",
  ),
  GOOGLE_DRIVE_ARCHIVE_REDIRECT_URI: optionalVar(
    "GOOGLE_DRIVE_ARCHIVE_REDIRECT_URI",
  ),
  GOOGLE_DRIVE_ARCHIVE_PICKER_API_KEY: optionalVar(
    "GOOGLE_DRIVE_ARCHIVE_PICKER_API_KEY",
  ),
  GOOGLE_DRIVE_ARCHIVE_PROJECT_NUMBER: optionalVar(
    "GOOGLE_DRIVE_ARCHIVE_PROJECT_NUMBER",
  ),
});

export const resolveWorkersSubdomain = (configured: string, scopeHint = "") =>
  Effect.gen(function* () {
    if (configured) return configured;
    const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;
    const observed = yield* CfWorkers.getSubdomain({ accountId }).pipe(
      Effect.catch((error) =>
        Effect.die(
          new Error(
            `Could not read the workers.dev subdomain: ${String(error)}${scopeHint}`,
          ),
        ),
      ),
    );
    return `${observed.subdomain}.workers.dev`;
  });

export const resolveSelfHostAccess = (
  stage: string,
  provision: boolean,
  workersSubdomain: string,
  selfHostDomain?: string,
) =>
  Effect.gen(function* () {
    let teamDomain = (yield* Config.string("TEAM_DOMAIN").pipe(
      Config.withDefault(""),
    )).trim();
    let policyAud: Alchemy.Input<string> = (yield* Config.string(
      "POLICY_AUD",
    ).pipe(Config.withDefault(""))).trim();
    if (!provision || (teamDomain && policyAud))
      return { teamDomain, policyAud };
    const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;
    const subdomain = yield* resolveWorkersSubdomain(
      workersSubdomain,
      accessScopeHint,
    );

    if (!teamDomain) {
      const organization = yield* ZeroTrust.listOrganizationsForAccount({
        accountId,
      }).pipe(
        Effect.catchTag("OrganizationNotFound", () => Effect.succeed(null)),
        Effect.catch((error) =>
          Effect.die(
            new Error(
              `Could not read the Zero Trust organization: ${String(error)}${accessScopeHint}`,
            ),
          ),
        ),
      );
      if (organization?.authDomain) {
        teamDomain = `https://${organization.authDomain}`;
      } else {
        const teamName = subdomain.replace(/\.workers\.dev$/, "");
        yield* ZeroTrust.createOrganizationForAccount({
          accountId,
          name: teamName,
          authDomain: `${teamName}.cloudflareaccess.com`,
        }).pipe(
          Effect.catch((error) =>
            Effect.die(
              new Error(
                `Could not create the Zero Trust team "${teamName}": ${String(error)}${accessScopeHint}. You can also create one by hand — open https://one.dash.cloudflare.com once to pick a team name (free plan is fine), then redeploy.`,
              ),
            ),
          ),
        );
        yield* Console.log(
          `Created the Zero Trust team "${teamName}" (${teamName}.cloudflareaccess.com) — its login page is where Cloudflare Access sends users to sign in.`,
        );
        teamDomain = `https://${teamName}.cloudflareaccess.com`;
      }
    }

    if (!policyAud) {
      const allowedEmails = yield* requireAllowedEmails(
        "Set ACCESS_ALLOWED_EMAILS to the comma-separated emails allowed through Cloudflare Access — or set TEAM_DOMAIN and POLICY_AUD to manage the Access application yourself.",
      );
      const application = yield* emailAccessGate({
        policyId: "SelfHostAllowUsers",
        applicationId: "SelfHostAccess",
        policyName: `open-seo ${stage} self-host users`,
        applicationName: `open-seo ${stage}`,
        domain: accessHostname(stage, subdomain, selfHostDomain),
        emails: allowedEmails,
      });
      policyAud = application.aud;
    }

    return { teamDomain, policyAud };
  });

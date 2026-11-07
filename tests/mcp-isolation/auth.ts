import { createHash, randomBytes } from "node:crypto";
import {
  expect,
  type APIRequest,
  type APIRequestContext,
  type APIResponse,
} from "@playwright/test";
import { z } from "zod";
import type { Credential } from "./mcp";

// What a real MCP client (Codex, Claude Code) registers as its callback.
const REDIRECT_URI = "http://localhost:1455/auth/callback";

/** A signed-up hosted user with its own cookie jar. */
export type Account = {
  label: string;
  name: string;
  email: string;
  password: string;
  baseURL: string;
  api: APIRequestContext;
};

async function readJson(response: APIResponse, what: string): Promise<unknown> {
  const text = await response.text();
  expect(
    response.ok(),
    `${what}: HTTP ${response.status()} ${text.slice(0, 300)}`,
  ).toBe(true);
  const parsed: unknown = JSON.parse(text);
  return parsed;
}

/**
 * Email + password sign-up through Better Auth. BYPASS_EMAIL_VERIFICATION=true
 * makes the response set the session cookie right away, and the session-create
 * hook mints the user's default organization. The context sends Origin on
 * every request because Better Auth checks it on POST.
 */
export async function signUp(
  request: APIRequest,
  baseURL: string,
  account: Pick<Account, "label" | "name" | "email" | "password">,
): Promise<Account> {
  const api = await request.newContext({
    baseURL,
    extraHTTPHeaders: { Origin: baseURL },
  });
  await readJson(
    await api.post("/api/auth/sign-up/email", {
      data: {
        name: account.name,
        email: account.email,
        password: account.password,
      },
    }),
    `sign up ${account.label}`,
  );
  return { ...account, baseURL, api };
}

const organizationListSchema = z.array(
  z.looseObject({ id: z.string(), name: z.string() }),
);

export async function listOrganizations(account: Account) {
  return organizationListSchema.parse(
    await readJson(
      await account.api.get("/api/auth/organization/list"),
      `list organizations for ${account.label}`,
    ),
  );
}

export async function setActiveOrganization(
  account: Account,
  organizationId: string,
) {
  await readJson(
    await account.api.post("/api/auth/organization/set-active", {
      data: { organizationId },
    }),
    `set active organization for ${account.label}`,
  );
}

const invitationSchema = z.looseObject({ id: z.string() });

/**
 * The raw invite endpoint creates the pending invitation and emails nobody
 * (the app's sendTeamInvitation server function is what sends mail), which is
 * exactly what the membership chapter needs. The response carries the
 * invitation id; `list-user-invitations` is avoided because it requires a
 * verified email, which BYPASS_EMAIL_VERIFICATION accounts never get.
 */
export async function inviteMember(
  inviter: Account,
  input: { email: string; organizationId: string },
) {
  const invitation = invitationSchema.parse(
    await readJson(
      await inviter.api.post("/api/auth/organization/invite-member", {
        // The app only ever mints "admin" (enforced in lib/auth.ts).
        data: { ...input, role: "admin" },
      }),
      `${inviter.label} invites ${input.email}`,
    ),
  );
  return invitation.id;
}

/** Also switches the accepting session's active organization to the new one. */
export async function acceptInvitation(account: Account, invitationId: string) {
  await readJson(
    await account.api.post("/api/auth/organization/accept-invitation", {
      data: { invitationId },
    }),
    `${account.label} accepts invitation`,
  );
}

export async function removeMember(
  owner: Account,
  input: { email: string; organizationId: string },
) {
  await readJson(
    await owner.api.post("/api/auth/organization/remove-member", {
      data: {
        memberIdOrEmail: input.email,
        organizationId: input.organizationId,
      },
    }),
    `${owner.label} removes ${input.email}`,
  );
}

const createdApiKeySchema = z.looseObject({ key: z.string() });

/**
 * The key is returned once. It is bound server-side to the session's active
 * organization (the /api-key/create before-hook in lib/auth.ts stamps
 * metadata.organizationId); the client never sends metadata.
 */
export async function createApiKey(
  account: Account,
  name: string,
): Promise<Credential> {
  const created = createdApiKeySchema.parse(
    await readJson(
      await account.api.post("/api/auth/api-key/create", { data: { name } }),
      `create API key "${name}" for ${account.label}`,
    ),
  );
  return { label: `${account.label} api-key (${name})`, secret: created.key };
}

const registrationSchema = z.looseObject({ client_id: z.string() });
const tokenResponseSchema = z.looseObject({ access_token: z.string() });

// Codex-style dynamic client registration: no token_endpoint_auth_method, so
// the server registers a public client.
async function registerOAuthClient(
  anon: APIRequestContext,
  clientName: string,
) {
  const registration = registrationSchema.parse(
    await readJson(
      await anon.post("/api/auth/oauth2/register", {
        data: {
          client_name: clientName,
          redirect_uris: [REDIRECT_URI],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
        },
      }),
      `register OAuth client "${clientName}"`,
    ),
  );
  return registration.client_id;
}

/**
 * The authorization-code + PKCE flow through the real HTTP endpoints. Only
 * the consent page's button click is replaced by its same-origin POST; the
 * server validates the signed-in session, active workspace, OAuth request,
 * and consent before issuing the code.
 */
export async function authorizeOAuth(
  anon: APIRequestContext,
  account: Account,
  options: { clientName: string },
): Promise<Credential> {
  const label = `${account.label} oauth (${options.clientName})`;
  const clientId = await registerOAuthClient(anon, options.clientName);
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");
  const resource = `${account.baseURL}/mcp`;
  const authorizeQuery = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    scope: "offline_access mcp",
    state: randomBytes(8).toString("hex"),
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    resource,
  });

  const authorizeResponse = await account.api.get(
    `/api/auth/oauth2/authorize?${authorizeQuery.toString()}`,
    { maxRedirects: 0 },
  );
  expect(authorizeResponse.status(), "signed-in authorize redirect").toBe(302);
  const consentUrl = new URL(
    authorizeResponse.headers().location ?? "",
    account.baseURL,
  );
  expect(consentUrl.pathname).toBe("/oauth-consent");
  expect(consentUrl.searchParams.get("client_id")).toBe(clientId);
  expect(consentUrl.searchParams.get("state")).toBe(
    authorizeQuery.get("state"),
  );

  // This is the POST made by the consent page's Authorize button. It keeps
  // the real same-origin check, session lookup, active-organization binding,
  // OAuth request validation, and provider code issuance on the server.
  const consentResponse = await readJson(
    await account.api.post("/api/oauth/consent", {
      headers: { Origin: account.baseURL },
      data: { accept: true, query: authorizeQuery.toString() },
    }),
    `consent for ${account.label}`,
  );
  const { redirectTo } = z
    .object({ redirectTo: z.string().url() })
    .parse(consentResponse);
  const callbackUrl = new URL(redirectTo);
  expect(callbackUrl.origin).toBe(new URL(REDIRECT_URI).origin);
  expect(callbackUrl.pathname).toBe(new URL(REDIRECT_URI).pathname);
  expect(callbackUrl.searchParams.get("state")).toBe(
    authorizeQuery.get("state"),
  );
  const code = callbackUrl.searchParams.get("code");
  expect(code, "authorization code in the callback redirect").toBeTruthy();

  const tokens = tokenResponseSchema.parse(
    await readJson(
      await anon.post("/api/auth/oauth2/token", {
        form: {
          grant_type: "authorization_code",
          code: code ?? "",
          redirect_uri: REDIRECT_URI,
          client_id: clientId,
          code_verifier: codeVerifier,
          resource,
        },
      }),
      `exchange code for ${account.label}`,
    ),
  );
  return { label, secret: tokens.access_token };
}

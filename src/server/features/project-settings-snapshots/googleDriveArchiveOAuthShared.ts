import { and, eq, gt, like, lt } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { verification } from "@/db/schema";
import { getOptionalEnvValue } from "@/server/lib/runtime-env";

export const GOOGLE_DRIVE_ARCHIVE_CALLBACK_PATH =
  "/api/google-drive/archive/oauth/callback";

export const API_ROOT = "/api/google-drive/archive";
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const GOOGLE_DRIVE_ABOUT_URL =
  "https://www.googleapis.com/drive/v3/about";
export const GOOGLE_DRIVE_FILES_URL =
  "https://www.googleapis.com/drive/v3/files";
export const GOOGLE_DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
export const OAUTH_SCOPES = [GOOGLE_DRIVE_SCOPE] as const;
const STATE_PREFIX = "google-drive-archive:";
const STATE_TTL_MS = 10 * 60_000;
const BROWSER_BINDING_LENGTH = 43;
export const TOKEN_SKEW_MS = 60_000;
export const REQUEST_TIMEOUT_MS = 15_000;

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

const stateSchema = z.object({
  userId: z.string().min(1),
  organizationId: z.string().min(1),
  redirectUri: z.string().url(),
  browserBindingHash: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
});
export type GoogleDriveArchiveOAuthState = z.infer<typeof stateSchema>;

export const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().optional(),
  id_token: z.string().min(1).optional(),
});

export const folderSelectionSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{5,200}$/u),
});

export const driveFolderSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(256),
  mimeType: z.string(),
  trashed: z.boolean(),
  capabilities: z.object({ canAddChildren: z.boolean().optional() }).optional(),
});

export type DriveArchiveConfig = {
  clientId: string;
  clientSecret: string;
  tokenKey: string;
  redirectUri: string;
  pickerApiKey: string | undefined;
  projectNumber: string | undefined;
};

export function googleDriveTokenContext(
  config: DriveArchiveConfig,
  organizationId: string,
  googleAccountId: string,
  purpose: "access" | "refresh",
) {
  return JSON.stringify([
    "open-seo-google-drive-token",
    "v2",
    config.clientId,
    organizationId,
    googleAccountId,
    purpose,
  ]);
}

export function noStoreHeaders(extra?: HeadersInit) {
  const headers = new Headers(extra);
  headers.set("Cache-Control", "no-store, private");
  headers.set("Pragma", "no-cache");
  headers.set("Referrer-Policy", "no-referrer");
  return headers;
}

export function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: noStoreHeaders({
      "Content-Type": "application/json; charset=utf-8",
    }),
  });
}

export function redirect(path: string) {
  return new Response(null, {
    status: 303,
    headers: noStoreHeaders({ Location: path }),
  });
}

export function genericError(status: number, code: string) {
  return jsonResponse({ error: code }, status);
}

export async function readConfig(): Promise<DriveArchiveConfig | null> {
  const [
    clientId,
    clientSecret,
    tokenKey,
    redirectUri,
    pickerApiKey,
    projectNumber,
  ] = await Promise.all([
    getOptionalEnvValue("GOOGLE_DRIVE_ARCHIVE_CLIENT_ID"),
    getOptionalEnvValue("GOOGLE_DRIVE_ARCHIVE_CLIENT_SECRET"),
    getOptionalEnvValue("GOOGLE_DRIVE_ARCHIVE_TOKEN_KEY_B64"),
    getOptionalEnvValue("GOOGLE_DRIVE_ARCHIVE_REDIRECT_URI"),
    getOptionalEnvValue("GOOGLE_DRIVE_ARCHIVE_PICKER_API_KEY"),
    getOptionalEnvValue("GOOGLE_DRIVE_ARCHIVE_PROJECT_NUMBER"),
  ]);
  const supplied = [clientId, clientSecret, tokenKey, redirectUri];
  if (supplied.every((value) => !value)) return null;
  if (supplied.some((value) => !value?.trim()))
    throw new Error("Google Drive OAuth configuration is incomplete.");
  const normalizedRedirect = redirectUri!.trim();
  const parsedRedirect = new URL(normalizedRedirect);
  if (
    !["https:", "http:"].includes(parsedRedirect.protocol) ||
    parsedRedirect.pathname !== GOOGLE_DRIVE_ARCHIVE_CALLBACK_PATH ||
    parsedRedirect.search ||
    parsedRedirect.hash ||
    parsedRedirect.username ||
    parsedRedirect.password ||
    (parsedRedirect.protocol !== "https:" &&
      parsedRedirect.hostname !== "localhost" &&
      !parsedRedirect.hostname.endsWith(".localhost"))
  )
    throw new Error("Google Drive OAuth callback configuration is invalid.");
  decodeTokenKey(tokenKey!.trim());
  return {
    clientId: clientId!.trim(),
    clientSecret: clientSecret!.trim(),
    tokenKey: tokenKey!.trim(),
    redirectUri: normalizedRedirect,
    pickerApiKey: pickerApiKey?.trim() || undefined,
    projectNumber: projectNumber?.trim() || undefined,
  };
}

function decodeTokenKey(encoded: string): ArrayBuffer {
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      encoded,
    )
  )
    throw new Error("Google Drive token encryption is not configured.");
  let bytes: Uint8Array;
  try {
    const binary = atob(encoded);
    bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new Error("Google Drive token encryption is not configured.");
  }
  if (bytes.byteLength !== 32)
    throw new Error("Google Drive token encryption is not configured.");
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export async function tokenCipher(config: DriveArchiveConfig) {
  const keyBytes = decodeTokenKey(config.tokenKey);
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
  return {
    async encrypt(value: string, context: string) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: toArrayBuffer(iv),
          additionalData: new TextEncoder().encode(context),
        },
        key,
        new TextEncoder().encode(value),
      );
      return `v2.${base64(iv)}.${base64(new Uint8Array(ciphertext))}`;
    },
    async decrypt(value: string, context: string) {
      const [version, encodedIv, encodedCiphertext, extra] = value.split(".");
      if (version !== "v2" || !encodedIv || !encodedCiphertext || extra)
        throw new Error("Stored Google Drive token is unreadable.");
      const plaintext = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: toArrayBuffer(fromBase64(encodedIv)),
          additionalData: new TextEncoder().encode(context),
        },
        key,
        toArrayBuffer(fromBase64(encodedCiphertext)),
      );
      return new TextDecoder().decode(plaintext);
    },
  };
}

function base64Url(bytes: Uint8Array): string {
  return base64(bytes)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

export async function hashBrowserBinding(browserBinding: string) {
  if (
    !new RegExp(`^[A-Za-z0-9_-]{${BROWSER_BINDING_LENGTH}}$`, "u").test(
      browserBinding,
    )
  )
    return null;
  return base64Url(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(browserBinding),
      ),
    ),
  );
}

export function sameBindingHash(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++)
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

export async function codeVerifier(state: string, clientSecret: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(
      `open-seo:google-drive-archive:pkce:${clientSecret}`,
    ),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return base64Url(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(state)),
    ),
  );
}

async function codeChallenge(verifier: string) {
  return base64Url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    ),
  );
}

async function createState(input: {
  userId: string;
  organizationId: string;
  redirectUri: string;
  browserBindingHash: string;
}) {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const state = base64Url(bytes);
  const now = new Date();
  await db
    .delete(verification)
    .where(
      and(
        like(verification.identifier, `${STATE_PREFIX}%`),
        lt(verification.expiresAt, now),
      ),
    );
  await db.insert(verification).values({
    id: crypto.randomUUID(),
    identifier: `${STATE_PREFIX}${state}`,
    value: JSON.stringify(input),
    expiresAt: new Date(now.getTime() + STATE_TTL_MS),
  });
  return state;
}

function isValidState(state: string | null): state is string {
  return Boolean(state && /^[A-Za-z0-9_-]{40,64}$/u.test(state));
}

function parseStateValue(value: string) {
  try {
    return stateSchema.parse(JSON.parse(value));
  } catch {
    return null;
  }
}

export async function readState(state: string | null) {
  if (!isValidState(state)) return null;
  const [row] = await db
    .select({ value: verification.value })
    .from(verification)
    .where(
      and(
        eq(verification.identifier, `${STATE_PREFIX}${state}`),
        gt(verification.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return row ? parseStateValue(row.value) : null;
}

export async function consumeState(state: string | null) {
  if (!isValidState(state)) return null;
  const [row] = await db
    .delete(verification)
    .where(
      and(
        eq(verification.identifier, `${STATE_PREFIX}${state}`),
        gt(verification.expiresAt, new Date()),
      ),
    )
    .returning({ value: verification.value });
  if (!row) return null;
  return parseStateValue(row.value);
}

export async function googleTokenRequest(params: Record<string, string>) {
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) return { response, tokens: null };
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { response, tokens: null };
  }
  const parsed = tokenResponseSchema.safeParse(payload);
  return { response, tokens: parsed.success ? parsed.data : null };
}

export async function createAuthorizationUrl(input: {
  config: DriveArchiveConfig;
  context: { userId: string; organizationId: string };
}) {
  const browserBinding = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const browserBindingHash = await hashBrowserBinding(browserBinding);
  if (!browserBindingHash)
    throw new Error("Google Drive browser binding could not be created.");
  const state = await createState({
    ...input.context,
    redirectUri: input.config.redirectUri,
    browserBindingHash,
  });
  const verifier = await codeVerifier(state, input.config.clientSecret);
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", input.config.clientId);
  url.searchParams.set("redirect_uri", input.config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", OAUTH_SCOPES.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent select_account");
  url.searchParams.set("include_granted_scopes", "false");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", await codeChallenge(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  return { authorizationUrl: url.toString(), browserBinding };
}

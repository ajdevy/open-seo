import { hasOrgPermission } from "@/lib/org-permissions";
import { saveConnection } from "./googleDriveArchiveOAuth";
import { getGoogleDriveAccountIdentity } from "./googleDriveArchiveOAuthAccount";
import {
  GOOGLE_DRIVE_SCOPE,
  codeVerifier,
  consumeState,
  genericError,
  googleTokenRequest,
  hashBrowserBinding,
  jsonResponse,
  readConfig,
  readState,
  redirect,
  sameBindingHash,
  type DriveArchiveConfig,
} from "./googleDriveArchiveOAuthShared";

function callbackReturn(code: "connected" | "failed") {
  return `/settings?googleDriveArchive=${code}`;
}

function callbackBridgeResponse() {
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const script = `(() => {
    const params = new URLSearchParams(window.location.search);
    const state = params.get("state");
    const code = params.get("code");
    const authorizationDenied = params.has("error");
    let browserBinding = null;
    try {
      if (state && /^[A-Za-z0-9_-]{40,64}$/.test(state)) {
        const key = "open-seo:google-drive-archive:" + state;
        browserBinding = window.sessionStorage.getItem(key);
        window.sessionStorage.removeItem(key);
      }
    } catch {
      // Browser storage can be disabled; fail closed below.
    }
    window.history.replaceState(null, "", window.location.pathname);
    if (!state || !browserBinding || (!code && !authorizationDenied)) {
      window.location.replace("${callbackReturn("failed")}");
      return;
    }
    fetch("/api/google-drive/archive/oauth/complete", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        state,
        browserBinding,
        ...(code ? { code } : {}),
        authorizationDenied,
      }),
    }).then(async (response) => {
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        if (payload && payload.error === "archive_target_change_blocked") {
          window.location.replace("/settings?googleDriveArchive=pending-snapshots");
          return;
        }
        throw new Error("OAuth completion failed");
      }
      window.location.replace("${callbackReturn("connected")}");
    }).catch(() => {
      window.location.replace("${callbackReturn("failed")}");
    });
  })();`;
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Finishing Google Drive connection</title></head><body><p>Finishing Google Drive connection…</p><script nonce="${nonce}">${script}</script></body></html>`,
    {
      status: 200,
      headers: {
        "Cache-Control": "no-store, private",
        "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
        "Content-Type": "text/html; charset=utf-8",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}

export async function handleGoogleDriveArchiveOAuthCallback(
  request: Request,
): Promise<Response> {
  try {
    const config = await readConfig();
    if (!config) return callbackBridgeResponse();
    const requestUrl = new URL(request.url);
    if (`${requestUrl.origin}${requestUrl.pathname}` !== config.redirectUri)
      return genericError(400, "invalid_callback");
    // Keep OAuth codes out of browser history even when a state has expired;
    // the authenticated completion endpoint is the authority for state checks.
    return callbackBridgeResponse();
  } catch {
    // OAuth state and provider response details must never enter logs.
    return redirect(callbackReturn("failed"));
  }
}

export async function completeGoogleDriveArchiveOAuth(input: {
  config: DriveArchiveConfig;
  context: { userId: string; organizationId: string; role: string };
  stateToken: string;
  browserBinding: string;
  code?: string;
  authorizationDenied: boolean;
}): Promise<Response> {
  const pending = await readState(input.stateToken);
  if (!pending || pending.redirectUri !== input.config.redirectUri)
    return genericError(409, "oauth_state_expired");
  const browserBindingHash = await hashBrowserBinding(input.browserBinding);
  if (
    !browserBindingHash ||
    !sameBindingHash(browserBindingHash, pending.browserBindingHash)
  )
    return genericError(403, "oauth_browser_mismatch");
  if (
    pending.userId !== input.context.userId ||
    pending.organizationId !== input.context.organizationId ||
    !hasOrgPermission(input.context.role, { integration: ["manage"] })
  )
    return genericError(403, "admin_required");

  const state = await consumeState(input.stateToken);
  if (
    !state ||
    state.userId !== pending.userId ||
    state.organizationId !== pending.organizationId ||
    !sameBindingHash(state.browserBindingHash, pending.browserBindingHash)
  )
    return genericError(409, "oauth_state_expired");
  if (input.authorizationDenied || !input.code)
    return genericError(400, "google_authorization_denied");

  const verifier = await codeVerifier(
    input.stateToken,
    input.config.clientSecret,
  );
  const { tokens } = await googleTokenRequest({
    code: input.code,
    client_id: input.config.clientId,
    client_secret: input.config.clientSecret,
    redirect_uri: input.config.redirectUri,
    grant_type: "authorization_code",
    code_verifier: verifier,
  });
  if (!tokens) return genericError(400, "google_token_exchange_failed");
  const scopes = new Set((tokens.scope ?? "").split(/\s+/u).filter(Boolean));
  if (scopes.size !== 1 || !scopes.has(GOOGLE_DRIVE_SCOPE))
    return genericError(400, "google_scope_invalid");
  let identity: Awaited<ReturnType<typeof getGoogleDriveAccountIdentity>>;
  try {
    identity = await getGoogleDriveAccountIdentity(tokens.access_token);
  } catch {
    return genericError(400, "google_account_unverified");
  }
  try {
    await saveConnection({
      config: input.config,
      state,
      tokens,
      googleAccountId: identity.googleAccountId,
      accountEmail: identity.accountEmail,
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "google_drive_archive_target_change_blocked"
    )
      return genericError(409, "archive_target_change_blocked");
    return genericError(503, "google_drive_archive_save_failed");
  }
  return jsonResponse({ connected: true });
}

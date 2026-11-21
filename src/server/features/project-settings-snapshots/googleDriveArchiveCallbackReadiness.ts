export const GOOGLE_DRIVE_ARCHIVE_CALLBACK_PROBE_PARAMETER =
  "__openSeoDriveArchiveCallbackReadiness";
export const GOOGLE_DRIVE_ARCHIVE_CALLBACK_PROBE_VERSION = "v1";
export const GOOGLE_DRIVE_ARCHIVE_CALLBACK_READY_HEADER =
  "x-open-seo-drive-archive-callback";
export const GOOGLE_DRIVE_ARCHIVE_CALLBACK_READY_VALUE = "ready";
const CALLBACK_PROBE_TIMEOUT_MS = 2_500;

export async function isGoogleDriveArchiveCallbackReady(
  redirectUri: string,
  requestOrigin: string,
): Promise<boolean> {
  try {
    const callbackUrl = new URL(redirectUri);
    if (callbackUrl.origin !== requestOrigin) return false;
    callbackUrl.searchParams.set(
      GOOGLE_DRIVE_ARCHIVE_CALLBACK_PROBE_PARAMETER,
      GOOGLE_DRIVE_ARCHIVE_CALLBACK_PROBE_VERSION,
    );
    const response = await fetch(callbackUrl, {
      method: "GET",
      headers: { Accept: "application/vnd.open-seo.drive-callback-probe" },
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(CALLBACK_PROBE_TIMEOUT_MS),
    });
    return (
      response.status === 204 &&
      response.headers.get(GOOGLE_DRIVE_ARCHIVE_CALLBACK_READY_HEADER) ===
        GOOGLE_DRIVE_ARCHIVE_CALLBACK_READY_VALUE
    );
  } catch {
    return false;
  }
}

export function googleDriveArchiveCallbackProbeResponse(
  request: Request,
  redirectUri: string | null,
): Response | null {
  const requestUrl = new URL(request.url);
  if (
    !requestUrl.searchParams.has(GOOGLE_DRIVE_ARCHIVE_CALLBACK_PROBE_PARAMETER)
  )
    return null;

  const exactProbe =
    request.method === "GET" &&
    requestUrl.searchParams.size === 1 &&
    requestUrl.searchParams.get(
      GOOGLE_DRIVE_ARCHIVE_CALLBACK_PROBE_PARAMETER,
    ) === GOOGLE_DRIVE_ARCHIVE_CALLBACK_PROBE_VERSION &&
    `${requestUrl.origin}${requestUrl.pathname}` === redirectUri;
  if (!exactProbe)
    return new Response(null, {
      status: 404,
      headers: { "Cache-Control": "no-store" },
    });

  return new Response(null, {
    status: 204,
    headers: {
      "Cache-Control": "no-store",
      [GOOGLE_DRIVE_ARCHIVE_CALLBACK_READY_HEADER]:
        GOOGLE_DRIVE_ARCHIVE_CALLBACK_READY_VALUE,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

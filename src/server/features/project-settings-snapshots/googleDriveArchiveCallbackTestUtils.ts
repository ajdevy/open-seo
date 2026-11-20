import {
  GOOGLE_DRIVE_ARCHIVE_CALLBACK_PROBE_PARAMETER,
  GOOGLE_DRIVE_ARCHIVE_CALLBACK_PROBE_VERSION,
  GOOGLE_DRIVE_ARCHIVE_CALLBACK_READY_HEADER,
  GOOGLE_DRIVE_ARCHIVE_CALLBACK_READY_VALUE,
} from "./googleDriveArchiveCallbackReadiness";

export function callbackProbeAwareFetch(
  fallback: typeof fetch = async () => new Response(null, { status: 404 }),
): typeof fetch {
  return async (input, init) => {
    const inputUrl =
      input instanceof Request
        ? input.url
        : input instanceof URL
          ? input.href
          : String(input);
    const url = new URL(inputUrl);
    if (
      url.searchParams.get(GOOGLE_DRIVE_ARCHIVE_CALLBACK_PROBE_PARAMETER) ===
      GOOGLE_DRIVE_ARCHIVE_CALLBACK_PROBE_VERSION
    )
      return new Response(null, {
        status: 204,
        headers: {
          [GOOGLE_DRIVE_ARCHIVE_CALLBACK_READY_HEADER]:
            GOOGLE_DRIVE_ARCHIVE_CALLBACK_READY_VALUE,
        },
      });
    return fallback(input, init);
  };
}

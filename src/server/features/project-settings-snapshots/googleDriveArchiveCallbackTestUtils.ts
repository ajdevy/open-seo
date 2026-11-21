import {
  GOOGLE_DRIVE_ARCHIVE_CALLBACK_PROBE_ACCEPT,
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
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    if (
      url.search === "" &&
      headers.get("Accept") === GOOGLE_DRIVE_ARCHIVE_CALLBACK_PROBE_ACCEPT
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

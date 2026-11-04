/**
 * Chromium's completed-response capture needs an explicit charset to decode
 * the same UTF-8 bytes that its live SSE consumer receives.
 */
export function ensureSseUtf8(response: Response): Response {
  const mediaType = response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (mediaType !== "text/event-stream") return response;

  const headers = new Headers(response.headers);
  headers.set("content-type", "text/event-stream; charset=utf-8");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

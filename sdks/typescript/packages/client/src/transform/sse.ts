import { Observable, Subject } from "rxjs";
import { HttpEvent, HttpEventType } from "../run/http-request";
import { type DebugLoggerInput, resolveDebugLogger } from "@/debug-logger";

/**
 * Maximum size the framing buffer is allowed to reach before the stream fails.
 *
 * The buffer holds the tail after the last \n\n, so a response that never sends a
 * boundary grows it to the size of the whole response. Mirrors
 * SseParser::kMaxBufferSize in the C++ SDK
 * (sdks/community/c++/src/stream/sse_parser.h), which caps the same
 * accumulation at 10 MB.
 *
 * Counted in decoded characters rather than bytes, because the buffer is
 * already a string at the point of the check.
 */
export const MAX_BUFFER_SIZE = 10 * 1024 * 1024;

/**
 * Parses a stream of HTTP events into a stream of JSON objects using Server-Sent Events (SSE) format.
 * Strictly follows the SSE standard where:
 * - Events are separated by double newlines ('\n\n')
 * - Only 'data:' prefixed lines are processed
 * - Multi-line data events are supported and joined
 * - Non-data fields (event, id, retry) are ignored
 */
export const parseSSEStream = (
  source$: Observable<HttpEvent>,
  debugLogger?: DebugLoggerInput,
  // DEFERRED (PNI-272): this is the exported stream element type; changing it
  // to `unknown` ripples into every consumer of parseSSEStream.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Observable<any> => {
  const log = resolveDebugLogger(debugLogger);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches the exported Observable<any> above
  const jsonSubject = new Subject<any>();
  // Create TextDecoder with stream option set to true to handle split UTF-8 characters
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let buffer = "";
  // How much of `buffer` has already been searched for a boundary. A read
  // that finds none leaves its last character unscanned, because the "\n\n"
  // it starts can be completed by the read that follows.
  let scanned = 0;

  // Subscribe to the source once and multicast to all subscribers
  source$.subscribe({
    next: (event: HttpEvent) => {
      if (event.type === HttpEventType.HEADERS) {
        return;
      }

      if (event.type === HttpEventType.DATA && event.data) {
        // Decode chunk carefully to handle UTF-8
        const text = decoder.decode(event.data, { stream: true });
        buffer += text;

        // Search only the part that has not been searched before. Splitting
        // the whole buffer on every read examines everything already held
        // again, so one event arriving over many reads costs time quadratic
        // in its size rather than linear.
        let eventStart = 0;
        let boundary = buffer.indexOf("\n\n", scanned);
        while (boundary !== -1) {
          processSSEEvent(buffer.slice(eventStart, boundary));
          eventStart = boundary + 2;
          boundary = buffer.indexOf("\n\n", eventStart);
        }

        // Keep the last potentially incomplete event in buffer
        if (eventStart > 0) {
          buffer = buffer.slice(eventStart);
        }
        scanned = Math.max(0, buffer.length - 1);

        // Measured on the tail that is left once completed events have been
        // taken out, because that tail is the only thing here that can grow
        // without bound. Measuring the incoming chunk instead would fail a
        // read that merely carried two valid events across one boundary, and
        // whether that happens is decided by how the transport grouped its
        // reads rather than by anything the stream did wrong.
        if (buffer.length > MAX_BUFFER_SIZE) {
          jsonSubject.error(
            new Error(
              `SSE buffer size exceeded maximum limit of ${MAX_BUFFER_SIZE / (1024 * 1024)} MB`,
            ),
          );
          return;
        }
      }
    },
    error: (err) => jsonSubject.error(err),
    complete: () => {
      // Use the final call to decoder.decode() to flush any remaining bytes
      if (buffer) {
        buffer += decoder.decode();
        // Process any remaining SSE event data
        processSSEEvent(buffer);
      }
      jsonSubject.complete();
    },
  });

  /**
   * Helper function to process an SSE event.
   * Extracts and joins data lines, then parses the result as JSON.
   *
   * Follows the SSE spec by processing lines starting with 'data:',
   * ignoring a single space if it is present after the colon.
   *
   * @param eventText The raw event text to process
   */
  function processSSEEvent(eventText: string) {
    const lines = eventText.split("\n");
    const dataLines: string[] = [];

    for (const line of lines) {
      if (line.startsWith("data:")) {
        // Remove 'data:' prefix, and optionally a single space afterwards
        dataLines.push(line.slice(5).replace(/^ /, ""));
      }
    }

    // Only process if we have data lines
    if (dataLines.length > 0) {
      try {
        // Join multi-line data and parse JSON
        const jsonStr = dataLines.join("\n");
        const json = JSON.parse(jsonStr);
        // `json` is whatever the frame held — `null` and primitives included,
        // so the type is read defensively: a throw here would surface as an
        // unhandled host error rather than as a stream failure.
        log?.event("SSE", "Event received:", json, {
          type: (json as { type?: unknown } | null)?.type,
        });
        jsonSubject.next(json);
      } catch (err) {
        jsonSubject.error(err);
      }
    }
  }

  return jsonSubject.asObservable();
};

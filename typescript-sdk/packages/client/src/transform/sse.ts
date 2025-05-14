import { Observable, Subject } from "rxjs";
import { HttpEvent, HttpEventType } from "../run/http-request";

/**
 * Parses a stream of HTTP events into a stream of JSON objects using Server-Sent Events (SSE) format.
 * Strictly follows the SSE standard where:
 * - Events are separated by double newlines ('\n\n')
 * - Only 'data:' prefixed lines are processed
 * - Multi-line data events are supported and joined
 * - Non-data fields (event, id, retry) are ignored
 */
export const parseSSEStream = (source$: Observable<HttpEvent>): Observable<any> => {
  const jsonSubject = new Subject<any>();
  // Create TextDecoder with stream option set to true to handle split UTF-8 characters
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let buffer = "";

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

        // Process complete events (separated by double newlines)
        const events = buffer.split(/\n\n/);
        // Keep the last potentially incomplete event in buffer
        buffer = events.pop() || "";

        for (const event of events) {
          processSSEEvent(event);
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
   * Follows the SSE spec by only processing 'data:' prefixed lines.
   * @param eventText The raw event text to process
   */
  function processSSEEvent(eventText: string) {
    const lines = eventText.split("\n");
    const dataLines: string[] = [];

    for (const line of lines) {
      if (line.startsWith("data: ")) {
        // Extract data content (remove 'data: ' prefix)
        dataLines.push(line.slice(6));
      }
    }

    // Only process if we have data lines
    if (dataLines.length > 0) {
      try {
        // Join multi-line data and parse JSON
        const jsonStr = dataLines.join("\n");
        const json = JSON.parse(jsonStr);
        jsonSubject.next(json);
      } catch (err) {
        jsonSubject.error(err);
      }
    }
  }

  return jsonSubject.asObservable();
};

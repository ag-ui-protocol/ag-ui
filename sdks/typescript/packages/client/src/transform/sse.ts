import { Observable, Subject } from "rxjs";
import { HttpEvent, HttpEventType } from "../run/http-request";
import { EventStreamParser } from "./base-type";
import { BaseEvent, EventSchemas, EventType } from "@ag-ui/core";

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
        jsonSubject.next(json);
      } catch (err) {
        jsonSubject.error(err);
      }
    }
  }

  return jsonSubject.asObservable();
};


/**
 * SSE Stream Parser that converts a stream of HttpEvents into parsed JSON objects based on the SSE format.
 * It listens for HttpDataEvents, decodes the data as UTF-8 text, and processes it according to SSE rules (lines starting with "data:").
 * Parsed JSON objects are emitted through the provided eventSubject.
 * Errors in parsing or unexpected formats will be emitted as errors on the eventSubject.
 * The parser will ignore HttpHeadersEvents and only process HttpDataEvents.
 * 
 * To use as part of the argument for transformHttpEventStreamFactory, simply pass in the parser function along with a condition that checks for the appropriate media type in the headers.
 * 
 * Example usage:
 * 
 * const transformStream = transformHttpEventStreamFactory([
 *  {
 *   condition: (event) => event.headers.get("content-type") === "text/event-stream", parser: defaultSSEStreamParser
 *  },
 * ]);
 */
export const defaultSSEStreamParser: EventStreamParser = (source$, eventSubject) => parseSSEStream(source$).subscribe({
  next: (json) => {
    try {
      const parsedEvent = EventSchemas.parse(json);
      eventSubject.next(parsedEvent as BaseEvent);
    } catch (err) {
      eventSubject.error(err);
    }
  },
  error: (err) => {
    if ((err as DOMException)?.name === "AbortError") {
      eventSubject.next({
        type: EventType.RUN_ERROR,
        message: (err as DOMException).message || "Request aborted",
        code: "abort",
        rawEvent: err,
      });
      eventSubject.complete();
      return;
    }
    return eventSubject.error(err)
  },
  complete: () => eventSubject.complete(),
})
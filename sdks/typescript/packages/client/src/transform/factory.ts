import { BaseEvent } from "@ag-ui/core";
import { Subject, ReplaySubject, Observable } from "rxjs";
import { HttpEvent, HttpEventType } from "../run/http-request";
import { TransformHttpEventStreamHandlers } from "./base-type";

/**
 * Factory function to create a transformHttpEventStream operator with customizable handlers for different content types.
 * It listens for the initial HttpHeadersEvent to determine the content type and then applies the appropriate parser to transform the stream of HttpEvents into BaseEvents.
 * Handlers are provided as an array of objects, each containing a condition function to match the headers and a parser function to process the events if the condition is met.
 * If no handlers match the content type, an error is emitted on the eventSubject.
 * The factory allows for flexible handling of various streaming formats (e.g., SSE, protocol buffers) based on the content type specified in the HTTP response headers.
 * 
 * Example usage:
 * 
 * const transformStream = transformHttpEventStreamFactory([
 *  {
 *   condition: (event) => event.headers.get("content-type") === "text/event-stream", parser: defaultSSEStreamParser
 *  },
 *  {
 *   condition: (event) => event.headers.get("content-type") === AGUI_MEDIA_TYPE, parser: defaultAGUIProtoStreamParser
 *  }
 * ]);
 */
export const transformHttpEventStreamFactory = (handlers: TransformHttpEventStreamHandlers[]) =>
  (source$: Observable<HttpEvent>): Observable<BaseEvent> => {
    const eventSubject = new Subject<BaseEvent>();

    // Use ReplaySubject to buffer events until we decide on the parser
    const bufferSubject = new ReplaySubject<HttpEvent>();

    // Flag to track whether we've set up the parser
    let parserInitialized = false;

    // Subscribe to source and buffer events while we determine the content type
    source$.subscribe({
      next: (event: HttpEvent) => {
        // Forward event to buffer
        bufferSubject.next(event);

        // If we get headers and haven't initialized a parser yet, check content type
        if (event.type === HttpEventType.HEADERS && !parserInitialized) {
          parserInitialized = true;
          const contentType = event.headers.get("content-type");


          // Choose parser based on content type
          const handler = handlers.find(h => h.condition(event));
          if (handler) {
            // Set up the parser with the buffered events
            handler.parser(bufferSubject, eventSubject);
          } else {
            eventSubject.error(new Error(`Unsupported content type: ${contentType}`));
          }
        } else if (!parserInitialized) {
          eventSubject.error(new Error("No headers event received before data events"));
        }
      },
      error: (err) => {
        bufferSubject.error(err);
        eventSubject.error(err);
      },
      complete: () => {
        bufferSubject.complete();
      },
    });

    return eventSubject.asObservable();
  };
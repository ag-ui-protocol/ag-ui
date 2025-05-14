import { BaseEvent, EventSchemas } from "@ag-ui/core";
import { Subject, ReplaySubject, Observable } from "rxjs";
import { HttpEvent, HttpEventType } from "../run/http-request";
import { parseSSEStream } from "./sse";
import { parseProtoStream } from "./proto";
import * as proto from "@ag-ui/proto";

/**
 * Transforms HTTP events into BaseEvents using the appropriate format parser based on content type.
 */
export const transformHttpEventStream = (source$: Observable<HttpEvent>): Observable<BaseEvent> => {
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
        if (contentType === proto.AGUI_MEDIA_TYPE) {
          // Use protocol buffer parser
          parseProtoStream(bufferSubject).subscribe({
            next: (event) => eventSubject.next(event),
            error: (err) => eventSubject.error(err),
            complete: () => eventSubject.complete(),
          });
        } else {
          // Use SSE JSON parser for all other cases
          parseSSEStream(bufferSubject).subscribe({
            next: (json) => {
              try {
                const parsedEvent = EventSchemas.parse(json);
                eventSubject.next(parsedEvent as BaseEvent);
              } catch (err) {
                eventSubject.error(err);
              }
            },
            error: (err) => eventSubject.error(err),
            complete: () => eventSubject.complete(),
          });
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

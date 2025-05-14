import { Observable, from, defer, throwError } from "rxjs";
import { switchMap } from "rxjs/operators";

export enum HttpEventType {
  HEADERS = "headers",
  DATA = "data",
}

export interface HttpDataEvent {
  type: HttpEventType.DATA;
  data?: Uint8Array;
}

export interface HttpHeadersEvent {
  type: HttpEventType.HEADERS;
  status: number;
  headers: Headers;
}

export type HttpEvent = HttpDataEvent | HttpHeadersEvent;

export const runHttpRequest = (url: string, requestInit: RequestInit): Observable<HttpEvent> => {
  // Defer the fetch so that it's executed when subscribed to
  return defer(() => from(fetch(url, requestInit))).pipe(
    switchMap((response) => {
      // Emit headers event first
      const headersEvent: HttpHeadersEvent = {
        type: HttpEventType.HEADERS,
        status: response.status,
        headers: response.headers,
      };

      const reader = response.body?.getReader();
      if (!reader) {
        return throwError(() => new Error("Failed to getReader() from response"));
      }

      return new Observable<HttpEvent>((subscriber) => {
        // Emit headers event first
        subscriber.next(headersEvent);

        (async () => {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              // Emit data event instead of raw Uint8Array
              const dataEvent: HttpDataEvent = {
                type: HttpEventType.DATA,
                data: value,
              };
              subscriber.next(dataEvent);
            }
            subscriber.complete();
          } catch (error) {
            subscriber.error(error);
          }
        })();

        return () => {
          reader.cancel();
        };
      });
    }),
  );
};

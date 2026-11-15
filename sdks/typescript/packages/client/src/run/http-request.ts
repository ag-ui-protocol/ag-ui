import { Observable, from, defer, throwError } from "rxjs";
import { mergeMap, switchMap } from "rxjs/operators";

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

/**
 * Thrown when `idleTimeoutMs` elapses with no response headers and no body
 * bytes. Distinct from a user `abortRun()`, which remains an AbortError.
 */
export class HttpAgentIdleTimeoutError extends Error {
  readonly code = "IDLE_TIMEOUT" as const;
  readonly idleTimeoutMs: number;

  constructor(idleTimeoutMs: number) {
    super(`HttpAgent idle timeout: no data received for ${idleTimeoutMs}ms`);
    this.name = "HttpAgentIdleTimeoutError";
    this.idleTimeoutMs = idleTimeoutMs;
  }
}

export interface RunHttpRequestOptions {
  /**
   * Abort when headers do not arrive within this many milliseconds, or when no
   * body bytes arrive for this long. Any body chunk — including SSE comment
   * keepalives — resets the timer. Unset means wait indefinitely.
   */
  idleTimeoutMs?: number;
  /**
   * Called after the idle timer fires so the caller can abort the in-flight
   * fetch. Invoked after the timeout error is emitted so a racing AbortError
   * cannot replace it.
   */
  onIdleTimeout?: (error: HttpAgentIdleTimeoutError) => void;
  /**
   * When this signal aborts for a reason other than the idle timeout, the
   * timer is cleared immediately so a later tick cannot report a timeout.
   */
  abortSignal?: AbortSignal;
}

export const runHttpRequest = (
  fetchResponse: () => Promise<Response>,
  options?: RunHttpRequestOptions,
): Observable<HttpEvent> => {
  // Defer the fetch so that it's executed when subscribed to
  const request$ = defer(() => from(fetchResponse())).pipe(
    switchMap((response) => {
      if (!response.ok) {
        const contentType = response.headers.get("content-type") || "";
        // Read the (small) error body once, then error the stream
        return from(response.text()).pipe(
          mergeMap((text) => {
            let payload: unknown = text;
            if (contentType.includes("application/json")) {
              try {
                payload = JSON.parse(text);
              } catch {
                /* keep raw text */
              }
            }
            const err: Error & { status?: number; payload?: unknown } = new Error(
              `HTTP ${response.status}: ${typeof payload === "string" ? payload : JSON.stringify(payload)}`,
            );
            err.status = response.status;
            err.payload = payload;
            return throwError(() => err);
          }),
        );
      }
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
        let settled = false;
        // Emit headers event first
        subscriber.next(headersEvent);

        (async () => {
          try {
            while (!subscriber.closed) {
              const { done, value } = await reader.read();
              if (done) {
                settled = true;
                break;
              }
              // Emit data event instead of raw Uint8Array
              const dataEvent: HttpDataEvent = {
                type: HttpEventType.DATA,
                data: value,
              };
              subscriber.next(dataEvent);
            }
            subscriber.complete();
          } catch (error) {
            settled = true;
            subscriber.error(error);
          }
        })();

        return () => {
          // An errored reader rejects cancel() with the already-delivered
          // stream error. Only early unsubscribe needs cancellation.
          if (settled) return;
          void reader.cancel().catch((error) => {
            if ((error as DOMException)?.name === "AbortError") {
              return;
            }

            // Teardown runs after the subscriber closes: there is no caller
            // to receive a rejection from this cleanup promise.
            console.warn("Failed to cancel HTTP response stream:", error);
          });
        };
      });
    }),
  );

  const idleTimeoutMs = options?.idleTimeoutMs;
  if (idleTimeoutMs === undefined) {
    return request$;
  }

  return withIdleTimeout(request$, idleTimeoutMs, options);
};

/**
 * Arms a timer on subscribe (time-to-headers) and resets it on every HttpEvent
 * (headers, then every body chunk). Parsed AG-UI events are irrelevant; an SSE
 * `: ping` comment is still a DATA chunk. Completing, erroring, unsubscribing,
 * or a user abort all clear the timer so it cannot fire after the run ends.
 */
function withIdleTimeout(
  source$: Observable<HttpEvent>,
  idleTimeoutMs: number,
  options?: RunHttpRequestOptions,
): Observable<HttpEvent> {
  return new Observable<HttpEvent>((subscriber) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const abortSignal = options?.abortSignal;

    const clearIdleTimer = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    };

    const armIdleTimer = () => {
      clearIdleTimer();
      timer = setTimeout(() => {
        if (timedOut) return;
        if (abortSignal?.aborted && !(abortSignal.reason instanceof HttpAgentIdleTimeoutError)) {
          return;
        }
        timedOut = true;
        clearIdleTimer();
        const error = new HttpAgentIdleTimeoutError(idleTimeoutMs);
        subscriber.error(error);
        options?.onIdleTimeout?.(error);
      }, idleTimeoutMs);
    };

    const onAbort = () => {
      if (timedOut) return;
      clearIdleTimer();
    };
    abortSignal?.addEventListener("abort", onAbort);

    armIdleTimer();
    const subscription = source$.subscribe({
      next: (event) => {
        if (timedOut) return;
        armIdleTimer();
        subscriber.next(event);
      },
      error: (err) => {
        if (timedOut) return;
        clearIdleTimer();
        subscriber.error(err);
      },
      complete: () => {
        if (timedOut) return;
        clearIdleTimer();
        subscriber.complete();
      },
    });

    return () => {
      abortSignal?.removeEventListener("abort", onAbort);
      clearIdleTimer();
      subscription.unsubscribe();
    };
  });
}

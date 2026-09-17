/**
 * Agno is a framework for building Multi-Agent Systems with memory, knowledge and reasoning.
 * Check more about using Agno: https://docs.agno.com/
 */

import { HttpAgent } from "@ag-ui/client";
import type { HttpAgentConfig } from "@ag-ui/client";
import { BaseEvent, EventType, RunAgentInput } from "@ag-ui/core";
import { Observable, Subscription } from "rxjs";

/**
 * The key a background run is requested and answered under.
 *
 * It appears twice: in `forwardedProps` on the way out, carrying the opt-in and
 * the cursor to resume from, and in each event's `metadata` on the way back,
 * carrying the cursor that event was delivered at.
 */
export const AGNO_BACKGROUND_KEY = "agnoBackground";

/** Where an event sat in a background run's stream. */
export interface AgnoBackgroundCursor {
  eventIndex: number;
  subIndex: number;
}

export interface AgnoAgentConfig extends HttpAgentConfig {
  /**
   * Ask the server to run detached from the request that starts it.
   *
   * The run then survives a dropped connection, and this agent reconnects to
   * it automatically, picking up from the last event it received. A server
   * that does not support background runs streams normally instead and no
   * reconnect is attempted; note that with `background` set, such a stream
   * cut short reaches the subscriber as an error rather than a quiet close.
   */
  background?: boolean;
  /**
   * How many times to reconnect after a drop that made no progress. Resets
   * whenever an attempt delivers an event, so a long run that keeps losing its
   * connection keeps going. Zero disables reconnecting. Defaults to 5.
   */
  maxReconnectAttempts?: number;
  /**
   * Delay before the first reconnect, in milliseconds. Doubles for each
   * consecutive failure that delivers nothing, up to ten seconds. Defaults
   * to 250.
   */
  reconnectDelayMs?: number;
}

const DEFAULT_MAX_RECONNECT_ATTEMPTS = 5;
const DEFAULT_RECONNECT_DELAY_MS = 250;
const MAX_RECONNECT_DELAY_MS = 10_000;

const TERMINAL_EVENT_TYPES: ReadonlySet<string> = new Set([
  EventType.RUN_FINISHED,
  EventType.RUN_ERROR,
]);

/**
 * The client transport reports a cancelled fetch as a RUN_ERROR carrying this
 * code rather than as a stream error. Read as-is: it is that layer's wire
 * value, not one this package defines.
 */
const TRANSPORT_ABORT_CODE = "abort";

function wholeNumberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : fallback;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCursorIndex(value: unknown, floor: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= floor;
}

function readCursor(event: BaseEvent): AgnoBackgroundCursor | undefined {
  const metadata = event.metadata as Record<string, unknown> | undefined;
  const marker = metadata?.[AGNO_BACKGROUND_KEY];
  if (!isPlainObject(marker)) {
    return undefined;
  }
  const { eventIndex, subIndex } = marker;
  // The events a run emits before its first buffered one sit at index -1, so
  // that is the floor there. A position within one event starts at zero.
  if (!isCursorIndex(eventIndex, -1) || !isCursorIndex(subIndex, 0)) {
    return undefined;
  }
  return { eventIndex, subIndex };
}

function isAfter(
  candidate: AgnoBackgroundCursor,
  held: AgnoBackgroundCursor,
): boolean {
  return (
    candidate.eventIndex > held.eventIndex ||
    (candidate.eventIndex === held.eventIndex &&
      candidate.subIndex > held.subIndex)
  );
}

/**
 * Hand the event onward without the resume marker.
 *
 * The marker is transport bookkeeping. Left in place it is folded into the
 * message the event builds and posted back to the server on the next request.
 */
function withoutMarker(event: BaseEvent): BaseEvent {
  const metadata = event.metadata as Record<string, unknown> | undefined | null;
  if (!isPlainObject(metadata) || !(AGNO_BACKGROUND_KEY in metadata)) {
    return event;
  }
  const { [AGNO_BACKGROUND_KEY]: _marker, ...rest } = metadata;
  const { metadata: _replaced, ...withoutMetadata } = event;
  return Object.keys(rest).length > 0
    ? { ...withoutMetadata, metadata: rest }
    : (withoutMetadata as BaseEvent);
}

function withBackgroundProps(
  input: RunAgentInput,
  cursor: AgnoBackgroundCursor | undefined,
): RunAgentInput {
  const request: Record<string, unknown> = { enabled: true };
  if (cursor !== undefined) {
    request.lastEventIndex = cursor.eventIndex;
    request.lastSubIndex = cursor.subIndex;
  }
  const forwardedProps = isPlainObject(input.forwardedProps)
    ? input.forwardedProps
    : {};
  const caller = forwardedProps[AGNO_BACKGROUND_KEY];
  // A caller's own keys are kept, but every field this agent owns is replaced,
  // including the resume position: leaving a stale one in place would silently
  // decide where a first connection starts reading.
  const carried = isPlainObject(caller) ? { ...caller } : {};
  delete carried.enabled;
  delete carried.lastEventIndex;
  delete carried.lastSubIndex;
  return {
    ...input,
    forwardedProps: {
      ...forwardedProps,
      [AGNO_BACKGROUND_KEY]: { ...carried, ...request },
    },
  };
}

/**
 * Whether an event is the transport reporting a cut connection rather than the
 * server reporting a failed run.
 *
 * The client transport turns a cancelled fetch into a RUN_ERROR carrying the
 * abort code and then completes. An abort the caller asked for is a real end
 * to the run; anything else is the connection going away mid-run.
 */
function isDroppedConnection(
  event: BaseEvent,
  aborted: boolean,
  resumable: boolean,
): boolean {
  if (event.type !== EventType.RUN_ERROR || aborted || !resumable) {
    return false;
  }
  if ((event as { code?: unknown }).code !== TRANSPORT_ABORT_CODE) {
    return false;
  }
  // A server that places its events places this one too, so an unplaced one on
  // a run that has been getting cursors was made up locally. On a run that has
  // never seen a cursor the server is not placing anything, and its own error
  // is the only account of what happened.
  return readCursor(event) === undefined;
}

export class AgnoAgent extends HttpAgent {
  public background: boolean;
  public maxReconnectAttempts: number;
  public reconnectDelayMs: number;

  constructor(config: AgnoAgentConfig) {
    super(config);
    this.background = config.background ?? false;
    this.maxReconnectAttempts =
      config.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;
    this.reconnectDelayMs =
      config.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    if (!this.background) {
      return super.run(input);
    }

    return new Observable<BaseEvent>((subscriber) => {
      // The base class swaps its abort controller on each runAgent and reads
      // the current one when it builds a request, so the current one is read
      // here too rather than captured. Everything else below belongs to this
      // subscription alone.
      const aborted = () => this.abortController.signal.aborted;
      const attempts = new Subscription();
      const log = this.debugLogger;

      let cursor: AgnoBackgroundCursor | undefined;
      // Only a server that answered with a cursor can be reconnected to. Until
      // one arrives, a dropped stream is indistinguishable from a server that
      // ignored the request, and reconnecting to such a server would start the
      // whole run a second time.
      let resumable = false;
      let closed = false;
      let failures = 0;
      let attemptCount = 0;
      let deliveredThisAttempt = false;
      let droppedUnplaceable = false;
      let retryTimer: ReturnType<typeof setTimeout> | undefined;
      let cancelWait: (() => void) | undefined;

      const stopWaiting = () => {
        if (retryTimer !== undefined) {
          clearTimeout(retryTimer);
          retryTimer = undefined;
        }
        cancelWait?.();
        cancelWait = undefined;
      };

      const stop = () => {
        closed = true;
        stopWaiting();
      };

      const finish = () => {
        stop();
        subscriber.complete();
      };

      const giveUp = (reason: string, cause?: unknown) => {
        stop();
        subscriber.error(
          new Error(`Agno background run ${input.runId} stopped: ${reason}`, {
            cause,
          }),
        );
      };

      /**
       * End an aborted run the way a plain HttpAgent does.
       *
       * An abort landing during a live attempt reaches the subscriber as the
       * transport's own RUN_ERROR followed by a close. One landing between
       * attempts has no live stream to produce that, so a matching event is
       * produced here rather than letting the same user action settle two
       * different ways. It carries the same type and code; the message and the
       * raw event are this package's own.
       */
      const endAsAborted = () => {
        stop();
        subscriber.next({
          type: EventType.RUN_ERROR,
          message: "Request aborted",
          code: TRANSPORT_ABORT_CODE,
          rawEvent: { reason: "aborted between attempts" },
        } as BaseEvent);
        subscriber.complete();
      };

      const endOfAttempt = (reason: string, cause?: unknown) => {
        if (closed) {
          return;
        }
        if (aborted()) {
          endAsAborted();
          return;
        }
        if (!resumable) {
          // Without a cursor there is no telling a server that never offered
          // background runs from one that did, and reconnecting to the former
          // would run the whole thing a second time.
          giveUp(
            `${reason}, and the server sent no resume cursor to reconnect with`,
            cause,
          );
          return;
        }
        // An attempt that delivered events made progress, so it does not count
        // against a budget meant to stop a connection that gets nowhere.
        failures = deliveredThisAttempt ? 0 : failures + 1;
        if (
          this.maxReconnectAttempts <= 0 ||
          failures > this.maxReconnectAttempts
        ) {
          giveUp(
            `${reason}, and ${this.maxReconnectAttempts} reconnect attempts made no progress`,
          );
          return;
        }
        // Doubling from the base on every consecutive attempt that gets
        // nowhere, so each wait is longer than the one before it.
        const delay = Math.min(
          this.reconnectDelayMs * 2 ** failures,
          MAX_RECONNECT_DELAY_MS,
        );
        log?.lifecycle(
          "AGNO",
          `Reconnecting to background run ${input.runId} in ${delay}ms: ${reason}`,
        );
        // A live attempt reports an abort through the transport, but one
        // landing in this wait has nothing to end the run, so the controller
        // that is current now is watched until the wait is over. A run started
        // after this one replaces that controller, in which case the abort is
        // noticed when the timer comes round instead.
        const waiting = this.abortController.signal;
        const onAbort = () => {
          stopWaiting();
          endAsAborted();
        };
        waiting.addEventListener("abort", onAbort, { once: true });
        cancelWait = () => waiting.removeEventListener("abort", onAbort);
        retryTimer = setTimeout(() => {
          stopWaiting();
          try {
            attach();
          } catch (error) {
            giveUp(error instanceof Error ? error.message : String(error));
          }
        }, delay);
      };

      const attach = () => {
        if (closed) {
          return;
        }
        if (aborted()) {
          endAsAborted();
          return;
        }
        attemptCount += 1;
        const isFirstAttempt = attemptCount === 1;
        deliveredThisAttempt = false;
        // Reset per attempt: the cursor never moves past an event that could
        // not be placed, so the next leg replays from before it and can still
        // deliver what this one had to drop.
        droppedUnplaceable = false;
        // Added to the parent subscription rather than held in a variable: a
        // synchronous emission that unsubscribes tears the parent down, and a
        // child added to a torn-down parent is unsubscribed on the spot. That
        // stops this agent listening; whether the request itself is cancelled
        // is the transport's business, and today it is not.
        attempts.add(
          super.run(withBackgroundProps(input, cursor)).subscribe({
            next: (event) => {
              if (closed) {
                return;
              }
              if (isDroppedConnection(event, aborted(), resumable)) {
                // Not part of the run, so it must not reach the subscriber: the
                // run verifier would latch it as a failure and reject every
                // event the reconnect goes on to deliver.
                log?.lifecycle(
                  "AGNO",
                  `Background run ${input.runId} lost its connection`,
                );
                return;
              }
              // A terminal is how the run ends, so neither guard below may
              // drop one: a dropped terminal leaves the run reconnecting
              // against a server that has already said its last word.
              const terminal = TERMINAL_EVENT_TYPES.has(event.type);
              const eventCursor = readCursor(event);
              if (eventCursor !== undefined) {
                resumable = true;
                if (
                  !terminal &&
                  !isFirstAttempt &&
                  cursor !== undefined &&
                  !isAfter(eventCursor, cursor)
                ) {
                  log?.lifecycle(
                    "AGNO",
                    `Dropped an already delivered event resuming background run ${input.runId}`,
                  );
                  // Already delivered on an earlier attempt. A server that
                  // replays inclusively would otherwise send a second
                  // RUN_STARTED into a run that is already open. Only from the
                  // second attempt on: nothing was delivered before the first.
                  return;
                }
                // A terminal ends the run, so its position is never somewhere
                // to resume from, and the run's last events are the ones a
                // server has least room to place uniquely.
                if (
                  !terminal &&
                  (cursor === undefined || isAfter(eventCursor, cursor))
                ) {
                  cursor = eventCursor;
                }
              } else if (!terminal && !isFirstAttempt) {
                // A resumed leg's event with no cursor cannot be placed, so it
                // cannot be shown to be new. It is dropped, and the leg is
                // remembered as having lost something so the run does not go
                // on to report a success it cannot stand behind.
                droppedUnplaceable = true;
                log?.lifecycle(
                  "AGNO",
                  `Dropped an unplaceable event resuming background run ${input.runId}`,
                );
                return;
              }
              if (terminal && droppedUnplaceable) {
                // The server stopped placing its events part-way through this
                // leg, so whatever it dropped is gone and this ending cannot
                // be taken at face value.
                giveUp(
                  "the server stopped placing its events, so part of the run was lost",
                  event,
                );
                return;
              }
              deliveredThisAttempt = true;
              subscriber.next(withoutMarker(event));
              if (terminal) {
                // The run is over, so there is nothing to wait for the socket
                // to say.
                finish();
              }
            },
            error: (error) =>
              endOfAttempt(
                error instanceof Error ? error.message : String(error),
                error,
              ),
            // A stream that ends without a terminal event is a dropped
            // connection wearing a clean close.
            complete: () =>
              endOfAttempt("the stream ended before the run finished"),
          }),
        );
      };

      try {
        attach();
      } catch (error) {
        // Mirrors the retry path, so a throw here cannot escape before the
        // teardown below exists to remove the abort listener.
        giveUp(error instanceof Error ? error.message : String(error));
      }

      return () => {
        stop();
        attempts.unsubscribe();
      };
    });
  }

  public clone(): AgnoAgent {
    const cloned = super.clone() as AgnoAgent;

    cloned.background = this.background;
    cloned.maxReconnectAttempts = this.maxReconnectAttempts;
    cloned.reconnectDelayMs = this.reconnectDelayMs;
    return cloned;
  }
}

import { Observable, of } from "rxjs";
import {
  BaseEvent,
  EventType,
  RunAgentInput,
  RunErrorEvent,
  RunFinishedEvent,
  RunStartedEvent,
} from "@ag-ui/core";
import { AbstractAgent, RunAgentResult } from "./agent";
import { AgentConfig, RunAgentParameters } from "./types";
import { AgentSubscriber } from "./subscriber";
import { structuredClone_ } from "@/utils";

/**
 * Delay before each replayed event. `0` (the default) emits as fast as the
 * pipeline will take events. A function is called with the event about to be
 * emitted and its index within the current run.
 */
export type ReplayDelayMs = number | ((event: BaseEvent, index: number) => number);

export interface ReplayAgentOptions extends AgentConfig {
  delayMs?: ReplayDelayMs;
}

interface ReplayRunAgentConfig extends RunAgentParameters {
  abortController?: AbortController;
}

const LIFECYCLE_TYPES = new Set<EventType>([
  EventType.RUN_STARTED,
  EventType.RUN_FINISHED,
  EventType.RUN_ERROR,
]);

/**
 * A recording is a flat event list, the same shape as a conformance fixture's
 * `stream` array. A run ends after `RUN_FINISHED` or `RUN_ERROR`, so any
 * following event begins a new run; `RUN_STARTED` also begins a new run when
 * the current run is non-empty.
 */
export function splitRecordedRuns(events: readonly BaseEvent[]): BaseEvent[][] {
  const runs: BaseEvent[][] = [];
  let current: BaseEvent[] = [];
  let ended = false;
  for (const event of events) {
    if (current.length > 0 && (ended || event.type === EventType.RUN_STARTED)) {
      runs.push(current);
      current = [];
      ended = false;
    }
    current.push(event);
    if (event.type === EventType.RUN_FINISHED || event.type === EventType.RUN_ERROR) {
      ended = true;
    }
  }
  if (current.length > 0) {
    runs.push(current);
  }
  return runs;
}

/**
 * Collects the events that reach `onEvent` so they can be serialized and later
 * loaded into {@link ReplayAgent}. `JSON.stringify(recorder)` writes the event
 * array; `JSON.parse` of that string is a valid `ReplayAgent` constructor
 * argument.
 */
export interface EventRecorder {
  readonly subscriber: AgentSubscriber;
  readonly events: BaseEvent[];
  toJSON(): BaseEvent[];
  /**
   * Detach from the agent `recordEvents` subscribed this recorder to and stop
   * collecting, including events from a run already in progress. Safe to call
   * more than once. A no-op when the recorder was created with
   * {@link createEventRecorder} and never attached.
   */
  stop(): void;
}

function createRecorder(onStop?: () => void): EventRecorder {
  const events: BaseEvent[] = [];
  let stopped = false;
  return {
    events,
    subscriber: {
      onEvent({ event }) {
        // A run copies the agent's subscriber list when it starts, so an
        // attached recorder can still be called after stop() detaches it.
        if (stopped && onStop) return;
        events.push(structuredClone_(event));
      },
    },
    toJSON() {
      return events;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      onStop?.();
    },
  };
}

export function createEventRecorder(): EventRecorder {
  return createRecorder();
}

/** Attach a recorder to `agent` for every subsequent run until `stop()`. */
export function recordEvents(agent: AbstractAgent): EventRecorder {
  let unsubscribe = () => {};
  const recorder = createRecorder(() => unsubscribe());
  unsubscribe = agent.subscribe(recorder.subscriber).unsubscribe;
  return recorder;
}

function resolveDelay(delayMs: ReplayDelayMs, event: BaseEvent, index: number): number {
  const value = typeof delayMs === "function" ? delayMs(event, index) : delayMs;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function abortEvent(signal: AbortSignal): RunErrorEvent {
  const reason = signal.reason;
  const error =
    reason instanceof Error
      ? reason
      : Object.assign(new Error("Request aborted"), { name: "AbortError" });
  return {
    type: EventType.RUN_ERROR,
    message: error.message || "Request aborted",
    code: "abort",
    rawEvent: error,
  };
}

/**
 * Rebind lifecycle events to the run that is playing them back. Message ids,
 * deltas, snapshots and every other field stay as recorded. `RUN_ERROR` only
 * gains new ids when the recording already carried them.
 */
function bindRunIds(event: BaseEvent, input: RunAgentInput): BaseEvent {
  if (!LIFECYCLE_TYPES.has(event.type as EventType)) {
    return event;
  }
  if (event.type === EventType.RUN_ERROR) {
    const next: RunErrorEvent = { ...(event as RunErrorEvent) };
    if ("threadId" in event) {
      (next as RunErrorEvent & { threadId: string }).threadId = input.threadId;
    }
    if ("runId" in event) {
      (next as RunErrorEvent & { runId: string }).runId = input.runId;
    }
    return next;
  }
  return {
    ...(event as RunStartedEvent | RunFinishedEvent),
    threadId: input.threadId,
    runId: input.runId,
  };
}

function playEvents(
  events: BaseEvent[],
  delayMs: ReplayDelayMs,
  signal: AbortSignal,
): Observable<BaseEvent> {
  return new Observable<BaseEvent>((subscriber) => {
    // Checked at subscribe time: the signal may abort between run() and
    // subscription, and its one "abort" event would then be missed.
    if (signal.aborted) {
      subscriber.next(abortEvent(signal));
      subscriber.complete();
      return;
    }
    if (events.length === 0) {
      subscriber.complete();
      return;
    }

    let index = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    const stopTimer = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    };

    const finishAbort = () => {
      if (stopped) return;
      stopped = true;
      stopTimer();
      subscriber.next(abortEvent(signal));
      subscriber.complete();
    };

    const fail = (err: unknown) => {
      if (stopped) return;
      stopped = true;
      stopTimer();
      subscriber.error(err);
    };

    const onAbort = () => finishAbort();
    signal.addEventListener("abort", onAbort);

    const schedule = () => {
      try {
        while (!stopped && index < events.length) {
          const event = events[index];
          const delay = resolveDelay(delayMs, event, index);
          index += 1;
          if (delay > 0) {
            timer = setTimeout(() => {
              timer = undefined;
              if (stopped) return;
              try {
                subscriber.next(event);
                schedule();
              } catch (err) {
                fail(err);
              }
            }, delay);
            return;
          }
          subscriber.next(event);
        }
        if (!stopped) {
          stopped = true;
          subscriber.complete();
        }
      } catch (err) {
        fail(err);
      }
    };

    schedule();

    return () => {
      stopped = true;
      stopTimer();
      signal.removeEventListener("abort", onAbort);
    };
  });
}

/**
 * Plays a recorded event stream through the normal `AbstractAgent` pipeline
 * (enforce, verify, apply, subscribers, middleware) with no network.
 *
 * A recorded run ends at `RUN_STARTED` of the next run or after `RUN_FINISHED`
 * or `RUN_ERROR`. Each `runAgent()` call consumes the next recorded run, in
 * order, and advances the playback cursor even when playback is aborted or
 * fails. Calling past the last run emits a `RUN_ERROR` rather than hanging or
 * completing silently. `abortRun()` stops playback promptly, including while
 * waiting on `delayMs`.
 */
export class ReplayAgent extends AbstractAgent {
  public events: BaseEvent[];
  public delayMs: ReplayDelayMs;
  public nextRunIndex: number;
  public abortController: AbortController;

  constructor(events: BaseEvent[], options: ReplayAgentOptions = {}) {
    const { delayMs = 0, ...agentConfig } = options;
    super(agentConfig);
    this.events = events.map((event) => structuredClone_(event));
    this.delayMs = delayMs;
    this.nextRunIndex = 0;
    this.abortController = new AbortController();
  }

  public runAgent(
    parameters?: ReplayRunAgentConfig,
    subscriber?: AgentSubscriber,
  ): Promise<RunAgentResult> {
    this.abortController = parameters?.abortController ?? new AbortController();
    return super.runAgent(parameters, subscriber);
  }

  abortRun() {
    this.abortController.abort();
    super.abortRun();
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    const runs = splitRecordedRuns(this.events);
    if (this.nextRunIndex >= runs.length) {
      const exhausted: RunErrorEvent = {
        type: EventType.RUN_ERROR,
        message: `ReplayAgent has no more recorded runs (played ${this.nextRunIndex} of ${runs.length}).`,
      };
      return of(exhausted);
    }
    const recorded = runs[this.nextRunIndex];
    this.nextRunIndex += 1;
    const events = recorded.map((event) => bindRunIds(event, input));
    return playEvents(events, this.delayMs, this.abortController.signal);
  }

  public clone(): ReplayAgent {
    const cloned = super.clone() as ReplayAgent;
    cloned.events = structuredClone_(this.events);
    cloned.delayMs = this.delayMs;
    cloned.nextRunIndex = this.nextRunIndex;

    const newController = new AbortController();
    const originalSignal = this.abortController.signal as AbortSignal & { reason?: unknown };
    if (originalSignal.aborted) {
      newController.abort(originalSignal.reason);
    }
    cloned.abortController = newController;

    return cloned;
  }
}

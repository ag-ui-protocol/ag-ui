import type { BaseEvent } from "@ag-ui/client";

/**
 * A queue of events produced beside the model stream: state snapshots and
 * custom events that tools emit while they run. The translator interleaves
 * them with the stream parts as soon as they arrive, so a long tool can show
 * progress before it returns.
 */
export class EventChannel {
  private queue: BaseEvent[] = [];
  private waiter: (() => void) | null = null;

  push(event: BaseEvent): void {
    this.queue.push(event);
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.();
  }

  /** Removes and returns everything queued so far. */
  drain(): BaseEvent[] {
    const events = this.queue;
    this.queue = [];
    return events;
  }

  /** Resolves once an event is queued (immediately if one already is). */
  next(): Promise<void> {
    if (this.queue.length > 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }
}

/**
 * Iterates `source`, yielding `{ part }` for each item and `{ events }`
 * whenever the channel has events, without waiting for the next item.
 */
export async function* mergeWithChannel<T>(
  source: AsyncIterable<T>,
  channel: EventChannel,
): AsyncGenerator<{ part: T } | { events: BaseEvent[] }> {
  const iterator = source[Symbol.asyncIterator]();
  // Settled, never rejected: a part promise that loses a race to the channel
  // stays pending across iterations, and a rejection there must not go unhandled.
  type Settled = { kind: "part"; result: IteratorResult<T> } | { kind: "error"; error: unknown };
  let pending: Promise<Settled> | null = null;
  let done = false;
  try {
    while (true) {
      pending ??= iterator.next().then(
        (result): Settled => ({ kind: "part", result }),
        (error: unknown): Settled => ({ kind: "error", error }),
      );
      const winner = await Promise.race([
        pending,
        // A macrotask later: parts the stream has already buffered go first,
        // so an event a tool emits does not overtake that tool's call.
        channel.next().then(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
          .then(() => ({ kind: "events" as const })),
      ]);
      if (winner.kind === "events") {
        const queued = channel.drain();
        if (queued.length > 0) yield { events: queued };
        continue;
      }
      if (winner.kind === "error") {
        pending = null;
        done = true;
        throw winner.error;
      }
      if (winner.kind === "part") {
        pending = null;
        if (winner.result.done) {
          done = true;
          return;
        }
        yield { part: winner.result.value };
      }
    }
  } finally {
    // Stopped early (the consumer broke off, or a part was pending): cancel
    // the source so the model request and its stream are released. Not
    // awaited: a pending part may never come.
    if (!done) void iterator.return?.();
  }
}

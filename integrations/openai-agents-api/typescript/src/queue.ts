/** What the run loop waits on: a session event, a wake-up, or the stream closing. */
export type QueueItem<T> =
  | { kind: "event"; event: T; source: number }
  | { kind: "wake" }
  | { kind: "closed"; error?: unknown; source: number };

export type QueueResult<T> = QueueItem<T> | { kind: "timeout" };

/**
 * A single-consumer queue that merges a session's event stream with internal
 * wake-ups (a backend tool finished, an interrupt was raised) so one loop can
 * react to both, with a timeout for the settle window and the watchdog.
 */
export class RunQueue<T> {
  private items: QueueItem<T>[] = [];
  private waiter: ((item: QueueResult<T>) => void) | undefined;

  push(item: QueueItem<T>): void {
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = undefined;
      resolve(item);
      return;
    }
    this.items.push(item);
  }

  wake(): void {
    this.push({ kind: "wake" });
  }

  next(timeoutMs: number): Promise<QueueResult<T>> {
    const item = this.items.shift();
    if (item) return Promise.resolve(item);
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => {
          if (this.waiter === settle) this.waiter = undefined;
          resolve({ kind: "timeout" });
        },
        Math.max(0, timeoutMs),
      );
      const settle = (value: QueueResult<T>) => {
        clearTimeout(timer);
        resolve(value);
      };
      this.waiter = settle;
    });
  }

  /**
   * Feeds a stream into the queue until it ends or fails. `source` tags its
   * items so the loop can ignore a stream it already replaced.
   */
  async pump(stream: AsyncIterable<T>, source: number): Promise<void> {
    try {
      for await (const event of stream)
        this.push({ kind: "event", event, source });
      this.push({ kind: "closed", source });
    } catch (error) {
      this.push({ kind: "closed", error, source });
    }
  }
}

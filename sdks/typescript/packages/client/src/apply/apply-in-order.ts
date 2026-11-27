import { Observable, type OperatorFunction, type Subscription } from "rxjs";

/** How many values an {@link applyInOrder} stream has received but not yet started on. */
export interface Backlog {
  waiting: number;
}

/**
 * `concatMap(project)` followed by `mergeAll()`, for a `project` that returns a
 * promise of an observable: handles one value at a time, in arrival order, and
 * passes on what each returned observable emits.
 *
 * rxjs keeps the values waiting for `concatMap` in an array and takes each one
 * with `shift()`, which costs time in proportion to the backlog. A replayed
 * thread arrives as one burst of tens of thousands of events, so that made
 * applying it quadratic. This queue advances an index instead.
 *
 * Timing matches the rxjs pair: a value that arrives while nothing is in
 * progress is handed to `project` synchronously, and the next waiting value is
 * started as soon as the previous observable completes. A source error is
 * passed on at once and drops the values still waiting, as with `concatMap`;
 * completion waits for the backlog to drain.
 *
 * `backlog.waiting` is kept up to date for the caller, and is already
 * decremented when `project` is called for a value.
 */
export function applyInOrder<T, R>(
  project: (value: T) => Promise<Observable<R>>,
  backlog: Backlog = { waiting: 0 },
): OperatorFunction<T, R> {
  return (source) =>
    new Observable<R>((subscriber) => {
      const queue: (T | undefined)[] = [];
      let head = 0;
      let busy = false;
      let sourceComplete = false;
      let inner: Subscription | undefined;

      const startNext = () => {
        if (busy || subscriber.closed) return;
        if (head === queue.length) {
          queue.length = 0;
          head = 0;
          if (sourceComplete) subscriber.complete();
          return;
        }
        const value = queue[head] as T;
        queue[head] = undefined; // Let the event be collected once applied.
        head += 1;
        backlog.waiting -= 1;
        busy = true;
        let pending: Promise<Observable<R>>;
        try {
          pending = project(value);
        } catch (error) {
          subscriber.error(error);
          return;
        }
        pending.then(
          (result$) => {
            if (subscriber.closed) return;
            inner = result$.subscribe({
              next: (result) => subscriber.next(result),
              error: (error) => subscriber.error(error),
              complete: () => {
                inner = undefined;
                busy = false;
                startNext();
              },
            });
          },
          (error) => subscriber.error(error),
        );
      };

      const sourceSubscription = source.subscribe({
        next: (value) => {
          queue.push(value);
          backlog.waiting += 1;
          startNext();
        },
        error: (error) => subscriber.error(error),
        complete: () => {
          sourceComplete = true;
          startNext();
        },
      });

      return () => {
        sourceSubscription.unsubscribe();
        inner?.unsubscribe();
      };
    });
}

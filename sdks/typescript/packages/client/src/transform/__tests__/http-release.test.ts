import { transformHttpEventStream } from "../http";
import { HttpEvent, HttpEventType } from "../../run/http-request";
import { BaseEvent, EventType } from "@ag-ui/core";
import { Observable, Subject } from "rxjs";
import { take } from "rxjs/operators";
import { describe, expect, test, vi } from "vitest";

const encoder = new TextEncoder();
const frame = (event: BaseEvent): HttpEvent => ({
  type: HttpEventType.DATA,
  data: encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
});
const headers: HttpEvent = {
  type: HttpEventType.HEADERS,
  status: 200,
  headers: new Headers([["content-type", "text/event-stream"]]),
};
const started: BaseEvent = { type: EventType.RUN_STARTED, threadId: "t", runId: "r" } as BaseEvent;
const finished: BaseEvent = {
  type: EventType.RUN_FINISHED,
  threadId: "t",
  runId: "r",
} as BaseEvent;

// The source's teardown stands in for runHttpRequest's, which cancels the
// response reader.
const trackedSource = () => {
  const http = new Subject<HttpEvent>();
  const released = vi.fn();
  const source$ = new Observable<HttpEvent>((subscriber) => {
    const subscription = http.subscribe(subscriber);
    return () => {
      released();
      subscription.unsubscribe();
    };
  });
  return { http, released, source$ };
};

const nextMacrotask = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("transformHttpEventStream release", () => {
  test("releases the source once its last subscriber lets go", async () => {
    const { http, released, source$ } = trackedSource();
    const events: BaseEvent[] = [];

    const subscription = transformHttpEventStream(source$).subscribe((event) => events.push(event));
    http.next(headers);
    http.next(frame(started));
    expect(events).toEqual([started]);

    subscription.unsubscribe();
    // Not synchronously: a caller may still subscribe again in this task.
    expect(released).not.toHaveBeenCalled();

    await nextMacrotask();
    expect(released).toHaveBeenCalledTimes(1);
    expect(http.observed).toBe(false);
  });

  test("keeps reading for a subscriber that arrives in the same task", async () => {
    const { http, released, source$ } = trackedSource();
    const events$ = transformHttpEventStream(source$);

    const first: BaseEvent[] = [];
    events$.pipe(take(1)).subscribe((event) => first.push(event));
    http.next(headers);
    http.next(frame(started));
    expect(first).toEqual([started]);

    const later: BaseEvent[] = [];
    events$.subscribe((event) => later.push(event));
    await nextMacrotask();
    expect(released).not.toHaveBeenCalled();

    http.next(frame(finished));
    expect(later).toEqual([finished]);
  });

  test("still releases the source when the stream completes", () => {
    const { http, released, source$ } = trackedSource();
    const events: BaseEvent[] = [];

    transformHttpEventStream(source$).subscribe((event) => events.push(event));
    http.next(headers);
    http.next(frame(finished));
    http.complete();

    expect(events).toEqual([finished]);
    expect(released).toHaveBeenCalledTimes(1);
  });
});

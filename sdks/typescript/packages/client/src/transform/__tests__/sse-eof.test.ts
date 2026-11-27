import { Subject } from "rxjs";
import { describe, expect, it, vi } from "vitest";
import { HttpAgent } from "../../agent/http";
import { parseSSEStream } from "../sse";
import { HttpEvent, HttpEventType } from "../../run/http-request";

describe("SSE end-of-stream framing", () => {
  it.each(["", "\n"])("discards valid JSON without a terminating blank line (%j)", (suffix) => {
    const source = new Subject<HttpEvent>();
    const received: unknown[] = [];
    const errors: unknown[] = [];
    parseSSEStream(source).subscribe({
      next: (event) => received.push(event),
      error: (error) => errors.push(error),
    });
    source.next({
      type: HttpEventType.DATA,
      data: new TextEncoder().encode(`data: {"type":"CUSTOM","name":"partial"}${suffix}`),
    });
    source.complete();
    expect(received).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("preserves complete events and discards a truncated trailing event at EOF", () => {
    const source = new Subject<HttpEvent>();
    const received: unknown[] = [];
    const errors: unknown[] = [];
    parseSSEStream(source).subscribe({
      next: (event) => received.push(event),
      error: (error) => errors.push(error),
    });
    source.next({
      type: HttpEventType.DATA,
      data: new TextEncoder().encode('data: {"type":"CUSTOM","name":"complete"}\n\ndata: {"type":'),
    });
    source.complete();
    expect(received).toEqual([{ type: "CUSTOM", name: "complete" }]);
    expect(errors).toEqual([]);
  });

  it("does not dispatch an unterminated RUN_FINISHED", () => {
    const source = new Subject<HttpEvent>();
    const received: unknown[] = [];
    parseSSEStream(source).subscribe((event) => received.push(event));
    source.next({
      type: HttpEventType.DATA,
      data: new TextEncoder().encode('data: {"type":"RUN_FINISHED","threadId":"t","runId":"r"}'),
    });
    source.complete();
    expect(received).toEqual([]);
  });

  it("still rejects malformed JSON in a fully delimited event", () => {
    const source = new Subject<HttpEvent>();
    const errors: unknown[] = [];
    parseSSEStream(source).subscribe({ error: (error) => errors.push(error) });
    source.next({ type: HttpEventType.DATA, data: new TextEncoder().encode('data: {"type":\n\n') });
    expect(errors).toEqual([expect.any(SyntaxError)]);
  });

  it("preserves transport errors with an incomplete frame buffered", () => {
    const source = new Subject<HttpEvent>();
    const errors: unknown[] = [];
    const failure = new Error("connection reset");
    parseSSEStream(source).subscribe({ error: (error) => errors.push(error) });
    source.next({ type: HttpEventType.DATA, data: new TextEncoder().encode('data: {"type":') });
    source.error(failure);
    expect(errors).toEqual([failure]);
  });

  it("dispatches a complete event when its final blank line spans reads", () => {
    const source = new Subject<HttpEvent>();
    const received: unknown[] = [];
    const complete = vi.fn();
    parseSSEStream(source).subscribe({ next: (event) => received.push(event), complete });
    const prefix = 'data: {"type":"CUSTOM","name":"complete"}\n';
    source.next({ type: HttpEventType.DATA, data: new TextEncoder().encode(prefix) });
    expect(received).toEqual([]);
    source.next({ type: HttpEventType.DATA, data: new TextEncoder().encode("\n") });
    expect(received).toEqual([{ type: "CUSTOM", name: "complete" }]);
    source.complete();
    expect(received).toHaveLength(1);
    expect(complete).toHaveBeenCalledOnce();
  });

  it.each(["", "\n", "\n\n"])(
    "only notifies HttpAgent of a delimited terminal event (%j)",
    async (suffix) => {
      const onRunFinishedEvent = vi.fn();
      const agent = new HttpAgent({
        url: "https://agent.example/run",
        threadId: "t",
        fetch: async () =>
          new Response(
            'data: {"type":"RUN_STARTED","threadId":"t","runId":"r"}\n\n' +
              'data: {"type":"RUN_FINISHED","threadId":"t","runId":"r"}' +
              suffix,
            { headers: { "Content-Type": "text/event-stream" } },
          ),
      });
      await agent.runAgent({ runId: "r" }, { onRunFinishedEvent });
      expect(onRunFinishedEvent).toHaveBeenCalledTimes(suffix === "\n\n" ? 1 : 0);
    },
  );
});

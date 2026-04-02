import { describe, it, expect, vi } from "vitest";
import { Observable, Subject } from "rxjs";
import { AbstractAgent } from "../agent";
import { BaseEvent, RunAgentInput, EventType } from "@ag-ui/core";

class TestAgent extends AbstractAgent {
  public subject = new Subject<BaseEvent>();

  run(_input: RunAgentInput): Observable<BaseEvent> {
    return this.subject.asObservable();
  }
}

/** Wait one macrotask so runAgent's pipeline has subscribed to the subject */
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("AbstractAgent notification throttle", () => {
  // ── Baseline (no throttle) ──────────────────────────────────────────

  it("without throttle config, onMessagesChanged fires for every chunk", async () => {
    const agent = new TestAgent();
    const calls: number[] = [];

    agent.subscribe({
      onMessagesChanged: ({ messages }) => {
        calls.push(messages.length);
      },
    });

    const runPromise = agent.runAgent();
    await tick();

    agent.subject.next({ type: EventType.RUN_STARTED } as BaseEvent);
    for (let i = 0; i < 5; i++) {
      agent.subject.next({
        type: EventType.TEXT_MESSAGE_CHUNK,
        messageId: "m1",
        delta: `chunk${i} `,
      } as BaseEvent);
    }
    agent.subject.next({ type: EventType.RUN_FINISHED } as BaseEvent);
    agent.subject.complete();

    await runPromise;

    expect(calls.length).toBeGreaterThanOrEqual(5);
  });

  // ── Time-based throttle ─────────────────────────────────────────────

  it("with intervalMs, fewer onMessagesChanged calls than chunks", async () => {
    const agent = new TestAgent({ notificationThrottle: { intervalMs: 50 } });
    const calls: string[] = [];

    agent.subscribe({
      onMessagesChanged: ({ messages }) => {
        const msg = messages[0];
        const content = msg?.role === "assistant" && typeof msg.content === "string" ? msg.content : "";
        calls.push(content);
      },
    });

    const runPromise = agent.runAgent();
    await tick();

    agent.subject.next({ type: EventType.RUN_STARTED } as BaseEvent);
    for (let i = 0; i < 20; i++) {
      agent.subject.next({
        type: EventType.TEXT_MESSAGE_CHUNK,
        messageId: "m1",
        delta: String.fromCharCode(65 + i),
      } as BaseEvent);
    }
    agent.subject.next({ type: EventType.RUN_FINISHED } as BaseEvent);
    agent.subject.complete();

    await runPromise;

    expect(calls.length).toBeLessThan(20);
    expect(calls[calls.length - 1]).toBe("ABCDEFGHIJKLMNOPQRST");
  });

  // ── Chunk-size throttle ─────────────────────────────────────────────

  it("with minChunkSize, notifications wait until enough chars accumulate", async () => {
    const agent = new TestAgent({
      notificationThrottle: { intervalMs: 500, minChunkSize: 10 },
    });
    const calls: string[] = [];

    agent.subscribe({
      onMessagesChanged: ({ messages }) => {
        const msg = messages[0];
        const content = msg?.role === "assistant" && typeof msg.content === "string" ? msg.content : "";
        calls.push(content);
      },
    });

    const runPromise = agent.runAgent();
    await tick();

    agent.subject.next({ type: EventType.RUN_STARTED } as BaseEvent);
    for (let i = 0; i < 20; i++) {
      agent.subject.next({
        type: EventType.TEXT_MESSAGE_CHUNK,
        messageId: "m1",
        delta: String.fromCharCode(65 + i),
      } as BaseEvent);
    }
    agent.subject.next({ type: EventType.RUN_FINISHED } as BaseEvent);
    agent.subject.complete();

    await runPromise;

    // minChunkSize=10: 20 single-char chunks → ~2-3 notifications
    expect(calls.length).toBeLessThanOrEqual(4);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[calls.length - 1]).toBe("ABCDEFGHIJKLMNOPQRST");
  });

  // ── Leading edge fires immediately ──────────────────────────────────

  it("with large throttle window, coalesces into leading + trailing notifications", async () => {
    const agent = new TestAgent({
      notificationThrottle: { intervalMs: 5000 },
    });
    const calls: string[] = [];

    agent.subscribe({
      onMessagesChanged: ({ messages }) => {
        const msg = messages[0];
        const content = msg?.role === "assistant" && typeof msg.content === "string" ? msg.content : "";
        calls.push(content);
      },
    });

    const runPromise = agent.runAgent();
    await tick();

    agent.subject.next({ type: EventType.RUN_STARTED } as BaseEvent);
    agent.subject.next({
      type: EventType.TEXT_MESSAGE_CHUNK,
      messageId: "m1",
      delta: "hello",
    } as BaseEvent);
    agent.subject.next({
      type: EventType.TEXT_MESSAGE_CHUNK,
      messageId: "m1",
      delta: " world",
    } as BaseEvent);
    agent.subject.next({ type: EventType.RUN_FINISHED } as BaseEvent);
    agent.subject.complete();

    await runPromise;

    // With 5s window, all events land within it → leading edge + finalize flush
    // Much fewer notifications than the ~4 mutations produced
    expect(calls.length).toBeGreaterThanOrEqual(1);
    // Final notification must contain full content
    expect(calls[calls.length - 1]).toBe("hello world");
  });

  // ── agent.messages stays current even when notification is deferred ─

  it("agent.messages is always up-to-date even between throttled notifications", async () => {
    const agent = new TestAgent({
      notificationThrottle: { intervalMs: 5000 },
    });
    const notificationContents: string[] = [];

    agent.subscribe({
      onMessagesChanged: ({ messages }) => {
        const msg = messages[0];
        const content = msg?.role === "assistant" && typeof msg.content === "string" ? msg.content : "";
        notificationContents.push(content);
      },
    });

    const runPromise = agent.runAgent();
    await tick();

    agent.subject.next({ type: EventType.RUN_STARTED } as BaseEvent);
    for (let i = 0; i < 10; i++) {
      agent.subject.next({
        type: EventType.TEXT_MESSAGE_CHUNK,
        messageId: "m1",
        delta: String.fromCharCode(65 + i),
      } as BaseEvent);
    }
    agent.subject.next({ type: EventType.RUN_FINISHED } as BaseEvent);
    agent.subject.complete();

    await runPromise;

    // Final notification must have all content
    expect(notificationContents[notificationContents.length - 1]).toBe("ABCDEFGHIJ");
    // agent.messages was current at the time of the finalize notification
    expect(agent.messages[0]).toBeDefined();
    const finalMsg = agent.messages[0];
    const finalContent = finalMsg?.role === "assistant" && typeof finalMsg.content === "string" ? finalMsg.content : "";
    expect(finalContent).toBe("ABCDEFGHIJ");
  });

  // ── State change notifications under throttle ───────────────────────

  it("onStateChanged is throttled and flushed correctly", async () => {
    const agent = new TestAgent({
      notificationThrottle: { intervalMs: 50 },
    });
    const stateCalls: any[] = [];

    agent.subscribe({
      onStateChanged: ({ state }) => {
        stateCalls.push(structuredClone(state));
      },
    });

    const runPromise = agent.runAgent();
    await tick();

    agent.subject.next({ type: EventType.RUN_STARTED } as BaseEvent);
    agent.subject.next({
      type: EventType.STATE_SNAPSHOT,
      snapshot: { count: 1 },
    } as BaseEvent);
    agent.subject.next({
      type: EventType.STATE_SNAPSHOT,
      snapshot: { count: 2 },
    } as BaseEvent);
    agent.subject.next({
      type: EventType.STATE_SNAPSHOT,
      snapshot: { count: 3 },
    } as BaseEvent);
    agent.subject.next({ type: EventType.RUN_FINISHED } as BaseEvent);
    agent.subject.complete();

    await runPromise;

    // Should have coalesced, but final state must be { count: 3 }
    expect(stateCalls.length).toBeGreaterThanOrEqual(1);
    expect(stateCalls[stateCalls.length - 1]).toEqual({ count: 3 });
  });

  // ── Subscriber error does not crash the pipeline ────────────────────

  it("subscriber error in throttled path is caught and does not crash", async () => {
    const agent = new TestAgent({
      notificationThrottle: { intervalMs: 50 },
    });
    const goodCalls: string[] = [];
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    agent.subscribe({
      onMessagesChanged: () => {
        throw new Error("boom");
      },
    });
    agent.subscribe({
      onMessagesChanged: ({ messages }) => {
        const msg = messages[0];
        const content = msg?.role === "assistant" && typeof msg.content === "string" ? msg.content : "";
        goodCalls.push(content);
      },
    });

    const runPromise = agent.runAgent();
    await tick();

    agent.subject.next({ type: EventType.RUN_STARTED } as BaseEvent);
    agent.subject.next({
      type: EventType.TEXT_MESSAGE_CHUNK,
      messageId: "m1",
      delta: "hello",
    } as BaseEvent);
    agent.subject.next({ type: EventType.RUN_FINISHED } as BaseEvent);
    agent.subject.complete();

    await runPromise;

    // The second (good) subscriber still received notifications
    expect(goodCalls.length).toBeGreaterThanOrEqual(1);
    expect(goodCalls[goodCalls.length - 1]).toBe("hello");
    // The error was logged
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("AG-UI: Subscriber onMessagesChanged threw"),
      expect.any(Error),
    );

    consoleErrorSpy.mockRestore();
  });

  // ── Clone preserves throttle config ─────────────────────────────────

  it("clone() preserves notificationThrottle config", () => {
    const agent = new TestAgent({
      notificationThrottle: { intervalMs: 42, minChunkSize: 10 },
    });

    const cloned = agent.clone();

    expect(cloned.notificationThrottle).toEqual({ intervalMs: 42, minChunkSize: 10 });
    // Should be a separate object
    expect(cloned.notificationThrottle).not.toBe(agent.notificationThrottle);
  });

  it("clone() preserves undefined notificationThrottle", () => {
    const agent = new TestAgent();
    const cloned = agent.clone();
    expect(cloned.notificationThrottle).toBeUndefined();
  });

  // ── Input validation ────────────────────────────────────────────────

  it("throws on negative intervalMs", () => {
    expect(() => new TestAgent({ notificationThrottle: { intervalMs: -1 } })).toThrow(
      "non-negative finite number",
    );
  });

  it("throws on NaN intervalMs", () => {
    expect(() => new TestAgent({ notificationThrottle: { intervalMs: NaN } })).toThrow(
      "non-negative finite number",
    );
  });

  it("throws on Infinity intervalMs", () => {
    expect(() => new TestAgent({ notificationThrottle: { intervalMs: Infinity } })).toThrow(
      "non-negative finite number",
    );
  });

  it("throws on negative minChunkSize", () => {
    expect(
      () => new TestAgent({ notificationThrottle: { intervalMs: 16, minChunkSize: -5 } }),
    ).toThrow("non-negative finite number");
  });

  it("accepts intervalMs: 0 without throwing", () => {
    expect(() => new TestAgent({ notificationThrottle: { intervalMs: 0 } })).not.toThrow();
  });
});

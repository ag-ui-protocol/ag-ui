import { describe, it, expect } from "vitest";
import { Observable, Subject } from "rxjs";
import { AbstractAgent } from "../agent";
import { BaseEvent, RunAgentInput, EventType } from "@ag-ui/core";

/**
 * Minimal concrete agent for testing.
 */
class TestAgent extends AbstractAgent {
  public subject = new Subject<BaseEvent>();

  run(_input: RunAgentInput): Observable<BaseEvent> {
    return this.subject.asObservable();
  }

  clone(): this {
    const cloned = new TestAgent() as this;
    cloned.agentId = this.agentId;
    return cloned;
  }
}

/** Wait one microtask so runAgent's pipeline has subscribed to the subject */
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("AbstractAgent notification throttle", () => {
  it("without throttle config, onMessagesChanged fires for every chunk", async () => {
    const agent = new TestAgent();
    const calls: number[] = [];

    agent.subscribe({
      onMessagesChanged: ({ messages }) => {
        calls.push(messages.length);
      },
    });

    const runPromise = agent.runAgent();
    await tick(); // let pipeline subscribe

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

    // Each TEXT_MESSAGE_CHUNK produces content events → onMessagesChanged
    expect(calls.length).toBeGreaterThanOrEqual(5);
  });

  it("with notificationThrottleMs, fewer onMessagesChanged calls than chunks", async () => {
    const agent = new TestAgent({ notificationThrottleMs: 50 });
    const calls: string[] = [];

    agent.subscribe({
      onMessagesChanged: ({ messages }) => {
        const content = (messages[0] as any)?.content ?? "";
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
        delta: String.fromCharCode(65 + i), // A, B, C, ...
      } as BaseEvent);
    }
    agent.subject.next({ type: EventType.RUN_FINISHED } as BaseEvent);
    agent.subject.complete();

    await runPromise;

    // With throttle, notifications should be coalesced
    expect(calls.length).toBeLessThan(20);
    // But the final notification must contain the full content
    expect(calls[calls.length - 1]).toBe("ABCDEFGHIJKLMNOPQRST");
  });

  it("with notificationMinChunkSize, notifications wait until enough chars accumulate", async () => {
    const agent = new TestAgent({ notificationMinChunkSize: 10, notificationThrottleMs: 500 });
    const calls: string[] = [];

    agent.subscribe({
      onMessagesChanged: ({ messages }) => {
        const content = (messages[0] as any)?.content ?? "";
        calls.push(content);
      },
    });

    const runPromise = agent.runAgent();
    await tick();

    agent.subject.next({ type: EventType.RUN_STARTED } as BaseEvent);
    // 20 single-char chunks → should batch ~10 chars per notification
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

    // With minChunkSize=10, 20 single-char chunks → ~2-3 notifications
    expect(calls.length).toBeLessThanOrEqual(4);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    // Final notification must have the full content
    expect(calls[calls.length - 1]).toBe("ABCDEFGHIJKLMNOPQRST");
  });
});

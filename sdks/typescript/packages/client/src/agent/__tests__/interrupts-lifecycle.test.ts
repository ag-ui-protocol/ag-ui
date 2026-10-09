import { describe, expect, it } from "vitest";
import { of } from "rxjs";
import { AbstractAgent } from "../agent";
import type { BaseEvent, RunAgentInput } from "@ag-ui/core";
import { EventType } from "@ag-ui/core";

class StubAgent extends AbstractAgent {
  public received?: RunAgentInput;
  run(input: RunAgentInput) {
    this.received = input;
    return of(
      { type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId } as BaseEvent,
      { type: EventType.RUN_FINISHED, threadId: input.threadId, runId: input.runId } as BaseEvent,
    );
  }
}

/** Replays a thread whose last run stopped on interrupt `int-1`. */
class InterruptedThreadAgent extends StubAgent {
  public connectInputs: RunAgentInput[] = [];
  protected connect(input: RunAgentInput) {
    this.connectInputs.push(input);
    return of(
      { type: EventType.RUN_STARTED, threadId: input.threadId, runId: "run-1" } as BaseEvent,
      {
        type: EventType.RUN_FINISHED,
        threadId: input.threadId,
        runId: "run-1",
        outcome: { type: "interrupt", interrupts: [{ id: "int-1", reason: "tool_call" }] },
      } as BaseEvent,
    );
  }
}

describe("AbstractAgent — interrupt lifecycle enforcement", () => {
  it("allows runAgent() when pendingInterrupts is empty", async () => {
    const agent = new StubAgent();
    await expect(agent.runAgent()).resolves.toBeDefined();
  });

  it("allows runAgent() when resume covers every pending interrupt", async () => {
    const agent = new StubAgent();
    agent.pendingInterrupts = [
      { id: "int-1", reason: "tool_call" },
      { id: "int-2", reason: "tool_call" },
    ];
    await expect(
      agent.runAgent({
        resume: [
          { interruptId: "int-1", status: "resolved", payload: { approved: true } },
          { interruptId: "int-2", status: "cancelled" },
        ],
      }),
    ).resolves.toBeDefined();
  });

  it("throws AGUIError when pending interrupts exist but resume is missing", async () => {
    const agent = new StubAgent();
    agent.pendingInterrupts = [{ id: "int-1", reason: "tool_call" }];
    await expect(agent.runAgent()).rejects.toThrow(/pending interrupt/i);
  });

  it("throws AGUIError when resume does not cover every pending interrupt", async () => {
    const agent = new StubAgent();
    agent.pendingInterrupts = [
      { id: "int-1", reason: "tool_call" },
      { id: "int-2", reason: "tool_call" },
    ];
    await expect(
      agent.runAgent({
        resume: [{ interruptId: "int-1", status: "resolved" }],
      }),
    ).rejects.toThrow(/int-2/);
  });

  it("throws AGUIError when a pending interrupt is past expiresAt", async () => {
    const agent = new StubAgent();
    agent.pendingInterrupts = [
      { id: "int-1", reason: "tool_call", expiresAt: "2000-01-01T00:00:00Z" },
    ];
    await expect(
      agent.runAgent({ resume: [{ interruptId: "int-1", status: "resolved" }] }),
    ).rejects.toThrow(/expired/i);
  });

  it("allows connectAgent() again after a replay recorded a pending interrupt", async () => {
    const agent = new InterruptedThreadAgent();
    await agent.connectAgent();
    expect(agent.pendingInterrupts.map((i) => i.id)).toEqual(["int-1"]);

    // A reconnect only reads the thread. It answers nothing, so it must not
    // require resume entries for the interrupt it is about to replay again.
    await expect(agent.connectAgent()).resolves.toBeDefined();
    expect(agent.connectInputs).toHaveLength(2);
    expect(agent.connectInputs[1]!.resume).toBeUndefined();
    expect(agent.pendingInterrupts.map((i) => i.id)).toEqual(["int-1"]);
  });

  it("allows connectAgent() while a pending interrupt is past expiresAt", async () => {
    const agent = new InterruptedThreadAgent();
    agent.pendingInterrupts = [
      { id: "int-1", reason: "tool_call", expiresAt: "2000-01-01T00:00:00Z" },
    ];
    await expect(agent.connectAgent()).resolves.toBeDefined();
    expect(agent.connectInputs).toHaveLength(1);
  });

  it("still rejects runAgent() without resume after a connect replayed the interrupt", async () => {
    const agent = new InterruptedThreadAgent();
    await agent.connectAgent();
    await expect(agent.runAgent()).rejects.toThrow(/pending interrupt.*int-1/i);
    expect(agent.received).toBeUndefined();
  });

  it("clone() preserves pendingInterrupts", () => {
    const agent = new StubAgent();
    agent.pendingInterrupts = [
      { id: "int-1", reason: "tool_call" },
      { id: "int-2", reason: "confirmation" },
    ];
    const cloned = agent.clone();
    expect(cloned.pendingInterrupts).toEqual(agent.pendingInterrupts);
    // Defensive copy: mutating the clone must not leak into the original.
    cloned.pendingInterrupts.push({ id: "int-3", reason: "tool_call" });
    expect(agent.pendingInterrupts).toHaveLength(2);
  });

  it("clone() leaves pendingInterrupts as a usable empty array on a fresh agent", async () => {
    const agent = new StubAgent();
    const cloned = agent.clone();
    // Regression test: Object.create skipped class field initializers, so
    // `pendingInterrupts` could land as `undefined` and runAgent() would throw
    // `TypeError: Cannot read properties of undefined (reading 'length')`.
    expect(cloned.pendingInterrupts).toEqual([]);
    await expect(cloned.runAgent()).resolves.toBeDefined();
  });
});

  it("allows cancelling an expired interrupt so the thread can continue", async () => {
    const agent = new StubAgent();
    agent.pendingInterrupts = [
      { id: "int-1", reason: "tool_call", expiresAt: "2000-01-01T00:00:00Z" },
    ];
    await expect(
      agent.runAgent({ resume: [{ interruptId: "int-1", status: "cancelled" }] }),
    ).resolves.toBeDefined();
  });

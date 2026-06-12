/**
 * Native interrupt flow (Strands SDK 1.1.0+): when the underlying
 * `AgentResult` comes back with `stopReason === "interrupt"`, the adapter
 * emits the interrupt-variant `RUN_FINISHED` and records the interrupt IDs
 * on the thread so the follow-up `resume[]` request is recognised as known
 * (rather than falling into the UNKNOWN_INTERRUPT gate).
 */
import { describe, it, expect } from "vitest";
import { EventType, type BaseEvent, type RunAgentInput } from "@ag-ui/core";
import {
  AgentResult as StrandsAgentResult,
  InterruptResponseContent,
  Message as StrandsMessage,
  TextBlock,
  type Interrupt as StrandsInterrupt,
} from "@strands-agents/sdk";

import { StrandsAgent } from "../agent";
import { collect, minimalRunInput, scriptedAgent } from "./helpers";

function makeAgentResultStream(
  result: StrandsAgentResult,
  events: unknown[] = [],
) {
  return async function* () {
    for (const e of events) yield e;
    return result;
  };
}

function strandsInterrupt(id: string, name: string): StrandsInterrupt {
  // The concrete class is internal; the adapter only reads .id / .name /
  // .reason, so a plain object that matches the interface is sufficient.
  return {
    id,
    name,
    reason: `Approve ${name}?`,
  } as unknown as StrandsInterrupt;
}

function buildAgentResult(interrupts: StrandsInterrupt[]): StrandsAgentResult {
  return new StrandsAgentResult({
    stopReason: "interrupt",
    lastMessage: StrandsMessage.fromMessageData({
      role: "assistant",
      content: [new TextBlock("awaiting approval").toJSON()],
    }),
    invocationState: {},
    interrupts,
  });
}

describe("StrandsAgent native interrupt bridge (Strands SDK 1.1.0+)", () => {
  it("emits RUN_FINISHED with outcome.interrupt when Strands stops for interrupt", async () => {
    const interrupts = [strandsInterrupt("int-1", "confirm_delete")];
    const stubAgent = scriptedAgent([], {
      stream: makeAgentResultStream(buildAgentResult(interrupts)) as never,
    });
    const sa = new StrandsAgent({ agent: stubAgent, name: "t" });
    (
      sa as unknown as { _agentsByThread: Map<string, unknown> }
    )._agentsByThread.set("thread-1", stubAgent);

    const events = await collect(sa);
    const finished = events.at(-1) as BaseEvent & {
      outcome?: { type: string; interrupts?: unknown[] };
    };
    expect(finished.type).toBe(EventType.RUN_FINISHED);
    expect(finished.outcome?.type).toBe("interrupt");
    expect(finished.outcome?.interrupts).toHaveLength(1);
    const first = finished.outcome?.interrupts?.[0] as {
      id: string;
      reason: string;
      message?: string;
      metadata?: { strandsName?: string };
    };
    expect(first.id).toBe("int-1");
    expect(first.reason).toBe("Approve confirm_delete?");
    expect(first.metadata?.strandsName).toBe("confirm_delete");

    // The interrupt is now pending on the thread.
    const pending = (
      sa as unknown as {
        _pendingInterruptsByThread: Map<string, Set<string>>;
      }
    )._pendingInterruptsByThread.get("thread-1");
    expect(pending?.has("int-1")).toBe(true);
  });

  it("accepts a matching resume[] and forwards InterruptResponseContent to Strands", async () => {
    let capturedArgs: unknown = null;
    const stubAgent = scriptedAgent([], {
      stream: ((args: unknown) => {
        capturedArgs = args;
        // After resume, Strands completes normally.
        return (async function* () {
          return new StrandsAgentResult({
            stopReason: "endTurn",
            lastMessage: StrandsMessage.fromMessageData({
              role: "assistant",
              content: [new TextBlock("done").toJSON()],
            }),
            invocationState: {},
          });
        })();
      }) as never,
    });
    const sa = new StrandsAgent({ agent: stubAgent, name: "t" });
    (
      sa as unknown as { _agentsByThread: Map<string, unknown> }
    )._agentsByThread.set("thread-1", stubAgent);
    // Seed a pending interrupt on the thread so the gate accepts the resume.
    (
      sa as unknown as {
        _pendingInterruptsByThread: Map<string, Set<string>>;
      }
    )._pendingInterruptsByThread.set("thread-1", new Set(["int-7"]));
    const input: RunAgentInput = minimalRunInput({
      resume: [
        {
          interruptId: "int-7",
          status: "resolved",
          payload: { approved: true },
        },
      ],
    });
    const events = await collect(sa, input);

    expect(events.map((e) => e.type)).toContain(EventType.RUN_FINISHED);
    expect(events.map((e) => e.type)).not.toContain(EventType.RUN_ERROR);

    // Strands received InterruptResponseContent[] as its invoke args.
    expect(Array.isArray(capturedArgs)).toBe(true);
    const [first] = capturedArgs as InterruptResponseContent[];
    expect(first).toBeInstanceOf(InterruptResponseContent);
    expect(first.interruptResponse.interruptId).toBe("int-7");
    expect(first.interruptResponse.response).toEqual({ approved: true });

    // The pending set was cleared once resume was accepted.
    const cleared = (
      sa as unknown as {
        _pendingInterruptsByThread: Map<string, Set<string>>;
      }
    )._pendingInterruptsByThread.get("thread-1");
    expect(cleared).toBeUndefined();
  });

  it("still emits UNKNOWN_INTERRUPT when resume[] references an unknown id", async () => {
    const stubAgent = scriptedAgent([]);
    const sa = new StrandsAgent({ agent: stubAgent, name: "t" });
    // One pending interrupt, but the resume references a different id.
    (
      sa as unknown as {
        _pendingInterruptsByThread: Map<string, Set<string>>;
      }
    )._pendingInterruptsByThread.set("thread-1", new Set(["known"]));

    const events = await collect(
      sa,
      minimalRunInput({
        resume: [{ interruptId: "unknown-id", status: "resolved" }],
      }),
    );
    expect(events.map((e) => e.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.RUN_ERROR,
    ]);
    const err = events[1] as unknown as { code: string; message: string };
    expect(err.code).toBe("UNKNOWN_INTERRUPT");
    expect(err.message).toContain("unknown-id");
  });

  it("forwards a cancelled resume as { status: 'cancelled' }", async () => {
    let capturedArgs: unknown = null;
    const stubAgent = scriptedAgent([], {
      stream: ((args: unknown) => {
        capturedArgs = args;
        return (async function* () {
          return new StrandsAgentResult({
            stopReason: "endTurn",
            lastMessage: StrandsMessage.fromMessageData({
              role: "assistant",
              content: [new TextBlock("ok").toJSON()],
            }),
            invocationState: {},
          });
        })();
      }) as never,
    });
    const sa = new StrandsAgent({ agent: stubAgent, name: "t" });
    (
      sa as unknown as { _agentsByThread: Map<string, unknown> }
    )._agentsByThread.set("thread-1", stubAgent);
    (
      sa as unknown as {
        _pendingInterruptsByThread: Map<string, Set<string>>;
      }
    )._pendingInterruptsByThread.set("thread-1", new Set(["ic"]));

    await collect(
      sa,
      minimalRunInput({
        resume: [{ interruptId: "ic", status: "cancelled" }],
      }),
    );

    const [first] = capturedArgs as InterruptResponseContent[];
    expect(first.interruptResponse.response).toEqual({ status: "cancelled" });
  });
});

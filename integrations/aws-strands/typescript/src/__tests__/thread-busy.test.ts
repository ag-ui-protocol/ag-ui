/**
 * Concurrent runs on the same thread must be rejected with a
 * protocol-shaped RUN_ERROR/THREAD_BUSY, not the internal Strands error
 * message.
 */

import { describe, it, expect } from "vitest";
import { EventType, type BaseEvent, type RunAgentInput } from "@ag-ui/core";

import { StrandsAgent } from "../agent";
import { minimalRunInput, scriptedAgent } from "./helpers";

function blockableAgent(): {
  stub: import("@strands-agents/sdk").Agent;
  release: () => void;
} {
  let resolveGate!: () => void;
  const gate = new Promise<void>((r) => {
    resolveGate = r;
  });
  const stub = scriptedAgent([], {
    stream: async function* () {
      // Block until the test releases the gate. Yielding nothing keeps the
      // adapter inside its main loop.
      await gate;
      // Emit a trivial finish so the caller's generator terminates cleanly.
      return;
    } as unknown as import("@strands-agents/sdk").Agent["stream"],
  });
  return { stub, release: resolveGate };
}

async function collectEvents(
  gen: AsyncGenerator<BaseEvent, void, void>,
): Promise<BaseEvent[]> {
  const out: BaseEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

describe("Concurrent runs on same thread → THREAD_BUSY", () => {
  it("rejects second invocation with RUN_ERROR/THREAD_BUSY and leaves first alone", async () => {
    const { stub, release } = blockableAgent();
    const agent = new StrandsAgent({ agent: stub, name: "t" });
    (
      agent as unknown as { _agentsByThread: Map<string, unknown> }
    )._agentsByThread.set("thread-1", stub);

    const input: RunAgentInput = minimalRunInput({ threadId: "thread-1" });

    // Kick off the first run and pull its first event so we know it has
    // registered itself as active before we start the second.
    const firstIter = agent.run(input);
    const firstStarted = (await firstIter.next()).value as
      | BaseEvent
      | undefined;
    expect(firstStarted?.type).toBe(EventType.RUN_STARTED);

    // Now the second run on the same thread should short-circuit.
    const secondEvents = await collectEvents(agent.run(input));
    expect(secondEvents.map((e) => e.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.RUN_ERROR,
    ]);
    const err = secondEvents[1] as unknown as { code: string; message: string };
    expect(err.code).toBe("THREAD_BUSY");
    expect(err.message).toMatch(/thread-1/);

    // Release the gate so the first iterator can finish, ensuring we're not
    // leaking a hung agent across tests.
    release();
    await collectEvents(firstIter);
  });

  it("separate threads can run concurrently without collision", async () => {
    const { stub: stub1, release: release1 } = blockableAgent();
    const { stub: stub2, release: release2 } = blockableAgent();
    const agent = new StrandsAgent({ agent: stub1, name: "t" });
    const internal = (
      agent as unknown as { _agentsByThread: Map<string, unknown> }
    )._agentsByThread;
    internal.set("a", stub1);
    internal.set("b", stub2);

    const inA = minimalRunInput({ threadId: "a", runId: "r-a" });
    const inB = minimalRunInput({ threadId: "b", runId: "r-b" });
    const itA = agent.run(inA);
    const itB = agent.run(inB);
    const firstA = (await itA.next()).value as BaseEvent;
    const firstB = (await itB.next()).value as BaseEvent;
    expect(firstA.type).toBe(EventType.RUN_STARTED);
    expect(firstB.type).toBe(EventType.RUN_STARTED);
    release1();
    release2();
    await collectEvents(itA);
    await collectEvents(itB);
  });
});

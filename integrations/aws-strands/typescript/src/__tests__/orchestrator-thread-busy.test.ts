/**
 * Concurrent runs on the orchestrator path (Graph/Swarm) must be rejected
 * with RUN_ERROR/THREAD_BUSY, not leak Strands's internal "already
 * processing" error.
 */

import { describe, it, expect } from "vitest";
import { EventType, type BaseEvent, type RunAgentInput } from "@ag-ui/core";

import { StrandsAgent } from "../agent";
import { collect, minimalRunInput } from "./helpers";

function blockableOrchestrator(): {
  stub: {
    stream: (input: string) => AsyncGenerator<unknown, unknown, unknown>;
  };
  release: () => void;
} {
  let resolveGate!: () => void;
  const gate = new Promise<void>((r) => {
    resolveGate = r;
  });
  const stub = {
    // No .model → adapter treats this as an orchestrator (Graph/Swarm).
    async *stream(_input: string) {
      await gate;
      return;
    },
  };
  return { stub, release: resolveGate };
}

async function drainIter(
  gen: AsyncGenerator<BaseEvent, void, void>,
): Promise<BaseEvent[]> {
  const out: BaseEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

describe("Orchestrator concurrent same-thread → THREAD_BUSY", () => {
  it("rejects second run with THREAD_BUSY and lets the first finish", async () => {
    const { stub, release } = blockableOrchestrator();
    const agent = new StrandsAgent({
      agent: stub as unknown as import("@strands-agents/sdk").Agent,
      name: "orch",
    });
    const input: RunAgentInput = minimalRunInput({ threadId: "orch-1" });

    const firstIter = agent.run(input);
    const firstStarted = (await firstIter.next()).value as
      | BaseEvent
      | undefined;
    expect(firstStarted?.type).toBe(EventType.RUN_STARTED);

    const secondEvents = await collect(agent, input);
    expect(secondEvents.map((e) => e.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.RUN_ERROR,
    ]);
    const err = secondEvents[1] as unknown as { code: string };
    expect(err.code).toBe("THREAD_BUSY");

    release();
    await drainIter(firstIter);
  });
});

/**
 * When the outer generator is abandoned, the Strands `Agent.stream()` call
 * must receive an aborted `cancelSignal` so Bedrock streaming stops
 * instead of silently burning tokens in the background.
 */

import { describe, it, expect } from "vitest";
import type { AgentStreamEvent } from "@strands-agents/sdk";

import { StrandsAgent } from "../agent";
import { minimalRunInput } from "./helpers";

function capturingStub(): {
  stub: import("@strands-agents/sdk").Agent;
  observed: {
    cancelSignal?: AbortSignal;
    aborted: () => boolean;
  };
} {
  let captured: AbortSignal | undefined;
  const stub = {
    model: {},
    tools: [],
    toolRegistry: {
      list: () => [],
      add() {},
      get: () => undefined,
      remove() {},
    },
    sessionManager: undefined,
    async *stream(
      _args: unknown,
      options?: { cancelSignal?: AbortSignal },
    ): AsyncGenerator<AgentStreamEvent, unknown, unknown> {
      captured = options?.cancelSignal;
      // Emit at least one benign event so the adapter's consumer loop
      // advances past the first `next()`. Then idle until the signal fires
      // so the test can observe the abort.
      yield {
        type: "modelContentBlockDeltaEvent",
        delta: { type: "textDelta", text: "hi" },
      } as unknown as AgentStreamEvent;
      while (true) {
        if (captured?.aborted) return;
        await new Promise((r) => setTimeout(r, 5));
      }
    },
  } as unknown as import("@strands-agents/sdk").Agent;
  return {
    stub,
    observed: {
      get cancelSignal() {
        return captured;
      },
      aborted: () => captured?.aborted ?? false,
    },
  };
}

describe("Strands cancelSignal propagation", () => {
  it("passes a cancelSignal to agent.stream() and aborts it on consumer bail", async () => {
    const { stub, observed } = capturingStub();
    const agent = new StrandsAgent({ agent: stub, name: "c" });
    (
      agent as unknown as { _agentsByThread: Map<string, unknown> }
    )._agentsByThread.set("thread-1", stub);

    const it = agent.run(minimalRunInput());
    // Drain events until the adapter is inside the Strands stream loop
    // (evidenced by the stub's `stream()` having been called). The adapter
    // yields RUN_STARTED + STATE_SNAPSHOT + (eventually) text events before
    // Strands's stream runs — drain up to 20 events or until the signal is
    // observed.
    for (let i = 0; i < 20; i++) {
      const step = await it.next();
      if (step.done) break;
      if (observed.cancelSignal) break;
    }
    expect(observed.cancelSignal).toBeInstanceOf(AbortSignal);
    expect(observed.aborted()).toBe(false);

    // Caller bails early (simulates HTTP client disconnect).
    await it.return?.();
    // The adapter's finally fires controller.abort() before draining the
    // generator, so the signal observed by Strands should now be aborted.
    expect(observed.aborted()).toBe(true);
  });
});

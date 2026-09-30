import { describe, it, expect } from "vitest";
import { AgentCapabilitiesSchema } from "@ag-ui/core/schemas";
import { FakeLocalAgent, FakeRemoteAgent } from "./helpers";
import { MastraAgent } from "../mastra";

// The AG-UI capabilities declaration: only what this adapter actually does.

function wrap(agent: unknown, extra: Record<string, unknown> = {}) {
  return new MastraAgent({
    agentId: "weather",
    agent: agent as any,
    resourceId: "resource-1",
    ...extra,
  });
}

describe("getCapabilities", () => {
  it("declares what the bridge supports for a local agent with memory", async () => {
    const capabilities = await wrap(new FakeLocalAgent(), {
      description: "Reports the weather",
    }).getCapabilities();

    expect(capabilities).toEqual({
      identity: {
        type: "mastra",
        name: "weather",
        description: "Reports the weather",
      },
      tools: { supported: true, clientProvided: true },
      state: { snapshots: true, deltas: true, persistentState: true },
      reasoning: { supported: true, streaming: true, encrypted: true },
      humanInTheLoop: { supported: true, interrupts: true, approvals: true },
    });
    expect(() => AgentCapabilitiesSchema.parse(capabilities)).not.toThrow();
  });

  it("leaves state undeclared for a local agent without memory", async () => {
    const fake = new FakeLocalAgent();
    fake.getMemory = async () => undefined as any;

    const capabilities = await wrap(fake).getCapabilities();

    expect(capabilities.state).toBeUndefined();
    expect(capabilities.humanInTheLoop?.interrupts).toBe(true);
  });

  it("declares state for a remote agent, whose memory lives on the server", async () => {
    const capabilities = await wrap(new FakeRemoteAgent()).getCapabilities();

    expect(capabilities.state).toEqual({
      snapshots: true,
      deltas: true,
      persistentState: true,
    });
    expect(capabilities.identity).toEqual({ type: "mastra", name: "weather" });
  });

  it("declares nothing that depends on the model or the agent's own tools", async () => {
    const capabilities = await wrap(new FakeLocalAgent()).getCapabilities();

    expect(capabilities.multimodal).toBeUndefined();
    expect(capabilities.multiAgent).toBeUndefined();
    expect(capabilities.tools?.items).toBeUndefined();
    expect(capabilities.tools?.parallelCalls).toBeUndefined();
    expect(capabilities.transport).toBeUndefined();
  });
});

import { describe, it, expect, vi } from "vitest";
import { EventType } from "@ag-ui/client";
import { AgentCapabilitiesSchema } from "@ag-ui/core/schemas";
import { Agent } from "@mastra/core/agent";
import { MockMemory } from "@mastra/core/memory";
import { MastraLanguageModelV2Mock } from "@mastra/core/test-utils/llm-mock";
import {
  FakeLocalAgent,
  FakeRemoteAgent,
  collectEvents,
  makeInput,
} from "./helpers";
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

function textModel() {
  return new MastraLanguageModelV2Mock({
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "text-delta", id: "t", delta: "ok" });
          controller.enqueue({
            type: "finish",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            finishReason: "stop",
          });
          controller.close();
        },
      }),
      request: { body: {} },
      response: undefined,
    }),
  });
}

function realAgent(memory?: MockMemory) {
  return new Agent({
    id: "weather",
    name: "weather",
    instructions: "Report the weather.",
    model: textModel() as any,
    ...(memory ? { memory: memory as any } : {}),
  });
}

describe("getCapabilities", () => {
  it("declares what the bridge supports for a local agent with working memory", async () => {
    const capabilities = await wrap(
      realAgent(new MockMemory({ enableWorkingMemory: true })),
      { description: "Reports the weather" },
    ).getCapabilities();

    expect(capabilities).toEqual({
      identity: {
        type: "mastra",
        name: "weather",
        description: "Reports the weather",
      },
      tools: { supported: true, clientProvided: true },
      state: { snapshots: true, deltas: true, persistentState: true },
      reasoning: { streaming: true },
      humanInTheLoop: { supported: true, interrupts: true, approvals: true },
    });
    expect(() => AgentCapabilitiesSchema.parse(capabilities)).not.toThrow();
  });

  it("leaves deltas undeclared for memory without working memory", async () => {
    const capabilities = await wrap(
      realAgent(new MockMemory()),
    ).getCapabilities();

    expect(capabilities.state).toEqual({
      snapshots: true,
      persistentState: true,
    });
  });

  it("keeps client state across runs for memory without working memory", async () => {
    // What the declaration above promises: input.state is written to memory
    // and comes back as a STATE_SNAPSHOT on a later run of the thread.
    const agent = wrap(realAgent(new MockMemory()));
    const user = { id: "u1", role: "user" as const, content: "Hi" };

    await collectEvents(
      agent,
      makeInput({ messages: [user], state: { city: "Paris" } }),
    );
    const events = await collectEvents(
      agent,
      makeInput({ runId: "run-2", messages: [user] }),
    );

    const snapshot = events.find(
      (e) => e.type === EventType.STATE_SNAPSHOT,
    ) as any;
    expect(snapshot?.snapshot).toEqual({ city: "Paris" });
    expect(events.some((e) => e.type === EventType.STATE_DELTA)).toBe(false);
  });

  it("leaves state undeclared for a local agent without memory", async () => {
    const fake = new FakeLocalAgent();
    fake.getMemory = async () => undefined as any;

    const capabilities = await wrap(fake).getCapabilities();

    expect(capabilities.state).toBeUndefined();
    expect(capabilities.humanInTheLoop?.interrupts).toBe(true);
  });

  it("warns and leaves state undeclared when getMemory throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failure = new Error("storage unavailable");
    const fake = new FakeLocalAgent();
    fake.getMemory = async () => {
      throw failure;
    };

    try {
      const capabilities = await wrap(fake).getCapabilities();

      expect(capabilities.state).toBeUndefined();
      expect(capabilities.tools).toEqual({
        supported: true,
        clientProvided: true,
      });
      expect(() => AgentCapabilitiesSchema.parse(capabilities)).not.toThrow();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain("[MastraAgent]");
      expect(String(warn.mock.calls[0][0])).toContain("weather");
      expect(warn.mock.calls[0][1]).toBe(failure);
    } finally {
      warn.mockRestore();
    }
  });

  it.each([
    ["without a remote client", {}],
    ["with a remote client", { remoteClient: {} }],
  ])(
    "leaves state undeclared for a remote agent %s, whose memory it cannot see",
    async (_label, extra) => {
      const capabilities = await wrap(
        new FakeRemoteAgent(),
        extra,
      ).getCapabilities();

      expect(capabilities.state).toBeUndefined();
      expect(capabilities.identity).toEqual({
        type: "mastra",
        name: "weather",
      });
    },
  );

  it("declares only how reasoning streams, not whether the model reasons or encrypts", async () => {
    const capabilities = await wrap(new FakeLocalAgent()).getCapabilities();

    expect(capabilities.reasoning).toEqual({ streaming: true });
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

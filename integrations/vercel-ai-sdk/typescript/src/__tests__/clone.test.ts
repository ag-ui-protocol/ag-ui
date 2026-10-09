import { describe, it, expect, vi } from "vitest";
import { simulateReadableStream } from "ai";
import type { LanguageModelV1 } from "ai";
import { VercelAISDKAgent } from "../index";

// The model is the network boundary: it streams one text part, then finishes.
const streamingModel: LanguageModelV1 = {
  specificationVersion: "v1",
  provider: "test",
  modelId: "test-model",
  defaultObjectGenerationMode: "json",
  doGenerate: vi.fn<LanguageModelV1["doGenerate"]>(),
  doStream: async () => ({
    stream: simulateReadableStream({
      chunks: [
        { type: "text-delta", textDelta: "hi" },
        {
          type: "finish",
          finishReason: "stop",
          usage: { promptTokens: 1, completionTokens: 1 },
        },
      ],
      initialDelayInMs: null,
      chunkDelayInMs: null,
    }),
    rawCall: { rawPrompt: null, rawSettings: {} },
  }),
};

// An agent whose messages, state, and thread differ from what the
// constructor gives a new instance.
function createAgentWithState() {
  const agent = new VercelAISDKAgent({
    agentId: "vercel-clone",
    model: streamingModel,
  });
  agent.setMessages([{ id: "msg-1", role: "user", content: "Hello" }]);
  agent.setState({ count: 1 });
  agent.threadId = "thread-before-clone";
  return agent;
}

describe("VercelAISDKAgent clone()", () => {
  it("keeps the current messages, state, and thread", () => {
    const agent = createAgentWithState();

    const cloned = agent.clone();

    expect(cloned).not.toBe(agent);
    expect(cloned).toBeInstanceOf(VercelAISDKAgent);
    expect(cloned.messages).toEqual([
      { id: "msg-1", role: "user", content: "Hello" },
    ]);
    expect(cloned.state).toEqual({ count: 1 });
    expect(cloned.threadId).toBe("thread-before-clone");
  });

  it("does not change the original when the clone's messages change", () => {
    const agent = createAgentWithState();

    const cloned = agent.clone();
    cloned.messages.push({ id: "msg-2", role: "user", content: "Clone only" });

    expect(agent.messages).toEqual([
      { id: "msg-1", role: "user", content: "Hello" },
    ]);
  });

  it("runs the middlewares added with use() when the clone runs", async () => {
    const agent = createAgentWithState();
    const seenThreadIds: string[] = [];
    agent.use((input, next) => {
      seenThreadIds.push(input.threadId);
      return next.run(input);
    });

    const cloned = agent.clone();
    await cloned.runAgent();

    expect(seenThreadIds).toEqual(["thread-before-clone"]);
  });
});

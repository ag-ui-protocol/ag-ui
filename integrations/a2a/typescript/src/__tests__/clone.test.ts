import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { A2AClient } from "@a2a-js/sdk/client";
import type { MessageSendParams } from "@a2a-js/sdk";
import { A2AAgent } from "../agent";

// The A2A server is the network boundary. The client streams one agent
// reply instead of calling a server.
class StreamingA2AClient extends A2AClient {
  async *sendMessageStream(_params: MessageSendParams) {
    yield {
      kind: "message" as const,
      messageId: "resp-1",
      role: "agent" as const,
      parts: [{ kind: "text" as const, text: "Hello from stream" }],
    };
  }
}

// An agent whose id, description, thread, messages, and state differ from
// what the constructor gives a new instance.
function createAgentWithState() {
  const agent = new A2AAgent({
    a2aClient: new StreamingA2AClient("https://agent.example.com"),
    agentId: "a2a-agent",
    description: "Talks to an A2A server",
    threadId: "thread-before-clone",
  });
  agent.setMessages([{ id: "msg-1", role: "user", content: "Hello" }]);
  agent.setState({ count: 1 });
  return agent;
}

describe("A2AAgent clone()", () => {
  beforeEach(() => {
    // The A2AClient constructor fetches the agent card.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ name: "Test Agent", url: "https://agent.example.com/rpc" }),
          ),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps the id, description, thread, messages, and state", () => {
    const agent = createAgentWithState();

    const cloned = agent.clone();

    expect(cloned).not.toBe(agent);
    expect(cloned).toBeInstanceOf(A2AAgent);
    expect(cloned.agentId).toBe("a2a-agent");
    expect(cloned.description).toBe("Talks to an A2A server");
    expect(cloned.threadId).toBe("thread-before-clone");
    expect(cloned.messages).toEqual([
      { id: "msg-1", role: "user", content: "Hello" },
    ]);
    expect(cloned.state).toEqual({ count: 1 });
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
    const result = await cloned.runAgent();

    expect(seenThreadIds).toEqual(["thread-before-clone"]);
    expect(result.newMessages).toEqual([
      expect.objectContaining({
        role: "assistant",
        content: "Hello from stream",
      }),
    ]);
  });
});

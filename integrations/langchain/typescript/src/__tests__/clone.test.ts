import { describe, it, expect } from "vitest";
import { LangChainAgent } from "../agent";

// An agent whose messages, state, and thread differ from what the
// constructor gives a new instance. The chainFn stands in for the LLM and
// streams one plain-string response.
function createAgentWithState() {
  const agent = new LangChainAgent({
    chainFn: async () => "hi",
  });
  agent.setMessages([{ id: "msg-1", role: "user", content: "Hello" }]);
  agent.setState({ count: 1 });
  agent.threadId = "thread-before-clone";
  return agent;
}

describe("LangChainAgent clone()", () => {
  it("keeps the current messages, state, and thread", () => {
    const agent = createAgentWithState();

    const cloned = agent.clone();

    expect(cloned).not.toBe(agent);
    expect(cloned).toBeInstanceOf(LangChainAgent);
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

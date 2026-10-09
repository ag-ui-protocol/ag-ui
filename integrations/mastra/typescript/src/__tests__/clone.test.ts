import { MastraClient } from "@mastra/client-js";
import { describe, expect, it } from "vitest";
import { MastraAgent } from "../mastra";

// A remote MastraAgent whose backend is a stubbed fetch (the network
// boundary). The backend agent is "native-agent". The public agentId is set
// to a different alias, so the test can tell the two ids apart.
function createAgentWithState() {
  const requests: URL[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    requests.push(url);
    if (url.pathname.endsWith("/working-memory")) {
      return request.method === "GET"
        ? Response.json({ workingMemory: JSON.stringify({}) })
        : Response.json({ success: true });
    }
    if (url.pathname === "/api/agents/native-agent/stream") {
      return new Response('data: {"type":"finish","payload":{}}\n\n', {
        headers: { "content-type": "text/event-stream" },
      });
    }
    throw new Error(`Unexpected request: ${request.method} ${url.pathname}`);
  };
  const client = new MastraClient({
    baseUrl: "http://mastra.test",
    retries: 0,
    fetch,
  });
  const agent = new MastraAgent({
    agentId: "native-agent",
    agent: client.getAgent("native-agent"),
    resourceId: "resource-1",
    remoteClient: client,
  });
  agent.agentId = "registry-alias";
  agent.setMessages([{ id: "msg-1", role: "user", content: "Hello" }]);
  agent.setState({ count: 1 });
  agent.threadId = "thread-before-clone";
  return { agent, requests };
}

describe("MastraAgent clone()", () => {
  it("keeps the current messages, state, thread, and public agentId", () => {
    const { agent } = createAgentWithState();

    const cloned = agent.clone();

    expect(cloned).not.toBe(agent);
    expect(cloned).toBeInstanceOf(MastraAgent);
    expect(cloned.messages).toEqual([
      { id: "msg-1", role: "user", content: "Hello" },
    ]);
    expect(cloned.state).toEqual({ count: 1 });
    expect(cloned.threadId).toBe("thread-before-clone");
    expect(cloned.agentId).toBe("registry-alias");
  });

  it("does not change the original when the clone's messages or state change", () => {
    const { agent } = createAgentWithState();

    const cloned = agent.clone();
    cloned.messages.push({ id: "msg-2", role: "user", content: "Clone only" });
    cloned.state.count = 2;

    expect(agent.messages).toEqual([
      { id: "msg-1", role: "user", content: "Hello" },
    ]);
    expect(agent.state).toEqual({ count: 1 });
  });

  it("runs the use() middlewares and calls the native backend agent when the clone runs", async () => {
    const { agent, requests } = createAgentWithState();
    const seenThreadIds: string[] = [];
    agent.use((input, next) => {
      seenThreadIds.push(input.threadId);
      return next.run(input);
    });

    const cloned = agent.clone();
    await cloned.runAgent();

    expect(seenThreadIds).toEqual(["thread-before-clone"]);
    const workingMemoryAgentIds = requests
      .filter((url) => url.pathname.endsWith("/working-memory"))
      .map((url) => url.searchParams.get("agentId"));
    expect(workingMemoryAgentIds).toEqual(["native-agent", "native-agent"]);
    expect(requests.at(-1)?.pathname).toBe("/api/agents/native-agent/stream");
  });
});

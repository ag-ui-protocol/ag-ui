import { MastraClient } from "@mastra/client-js";
import { describe, expect, it } from "vitest";
import { MastraAgent } from "../mastra";
import { collectEvents, makeInput } from "./helpers";

function remoteFixture(missingThread = false) {
  const requests: Array<{ method: string; url: URL; body: unknown }> = [];
  let writes = 0;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const body: unknown =
      request.method === "POST" ? await request.json() : undefined;
    requests.push({ method: request.method, url, body });
    if (url.pathname.endsWith("/working-memory")) {
      if (request.method === "GET") {
        return Response.json({
          workingMemory: JSON.stringify({ retained: true }),
        });
      }
      if (missingThread && writes++ === 0) {
        return Response.json({ error: "Thread not found" }, { status: 404 });
      }
      return Response.json({ success: true });
    }
    if (url.pathname.endsWith("/memory/threads")) {
      return Response.json({ id: "thread-1", resourceId: "resource-1" });
    }
    if (/\/agents\/[^/]+\/(stream|resume-stream)$/.test(url.pathname)) {
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
  const config = {
    agentId: "native-agent",
    agent: client.getAgent("native-agent"),
    resourceId: "resource-1",
    remoteClient: client,
  };
  const agent = new MastraAgent(config);
  return { agent, config, requests };
}

describe("remote native agent identity", () => {
  it.each([false, true])(
    "keeps backend identity after runtime aliasing (missing thread: %s)",
    async (missingThread) => {
      const { agent, config, requests } = remoteFixture(missingThread);
      config.agentId = "mutated-config";
      agent.agentId = "registry-alias";
      const cloned = agent.clone();
      cloned.agentId = "runtime-alias";

      const events = await collectEvents(
        cloned,
        makeInput({ state: { edited: true } }),
      );

      expect(events.at(-1)?.type).toBe("RUN_FINISHED");
      expect(cloned.agentId).toBe("runtime-alias");
      const memoryRequests = requests.filter(({ url }) =>
        url.pathname.includes("/memory/"),
      );
      expect(
        memoryRequests.map(({ url }) => url.searchParams.get("agentId")),
      ).toEqual(Array(missingThread ? 4 : 2).fill("native-agent"));
      expect(memoryRequests.at(-1)?.body).toEqual({
        resourceId: "resource-1",
        workingMemory: JSON.stringify({ retained: true, edited: true }),
      });
      if (missingThread) {
        expect(memoryRequests[2]?.body).toMatchObject({
          agentId: "native-agent",
          threadId: "thread-1",
        });
      }
      expect(requests.at(-1)?.url.pathname).toBe(
        "/api/agents/native-agent/stream",
      );
      expect(requests.at(-1)?.body).toMatchObject({
        memory: { thread: "thread-1", resource: "resource-1" },
      });
    },
  );

  it("resumes the native agent after runtime aliasing", async () => {
    const { agent, requests } = remoteFixture();
    const cloned = agent.clone();
    cloned.agentId = "runtime-alias";
    await collectEvents(
      cloned,
      makeInput({
        forwardedProps: {
          command: {
            resume: { approved: true },
            interruptEvent: { toolCallId: "native-tool", runId: "native-run" },
          },
        },
      }),
    );
    expect(requests.at(-1)?.url.pathname).toBe(
      "/api/agents/native-agent/resume-stream",
    );
    expect(requests.at(-1)?.body).toMatchObject({
      runId: "native-run",
      toolCallId: "native-tool",
      resumeData: { approved: true },
      memory: { thread: "thread-1", resource: "resource-1" },
    });
  });
});

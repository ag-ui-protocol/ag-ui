import { MastraClient } from "@mastra/client-js";
import { describe, expect, it } from "vitest";
import { MastraAgent } from "../mastra";
import { collectEvents, makeInput } from "./helpers";

function remoteFixture(
  missingThread = false,
  nativeId: string | null = "native-agent",
) {
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
    agentId: nativeId ?? undefined,
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
      expect(cloned.agentId).toBe("registry-alias");
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

  it("clone keeps the source alias and the native backend id", async () => {
    const { agent, requests } = remoteFixture();
    agent.agentId = "registry-alias";
    const cloned = agent.clone();
    const reCloned = cloned.clone();

    expect(cloned.agentId).toBe("registry-alias");
    expect(reCloned.agentId).toBe("registry-alias");

    await collectEvents(reCloned, makeInput({ state: { edited: true } }));

    const memoryRequests = requests.filter(({ url }) =>
      url.pathname.includes("/memory/"),
    );
    expect(
      memoryRequests.map(({ url }) => url.searchParams.get("agentId")),
    ).toEqual(["native-agent", "native-agent"]);
    expect(requests.at(-1)?.url.pathname).toBe(
      "/api/agents/native-agent/stream",
    );
  });

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

  it.each([null, ""])(
    "falls back to the public agentId when constructed with agentId %j",
    async (nativeId) => {
      const { agent, requests } = remoteFixture(false, nativeId);
      agent.agentId = "public-agent";

      await collectEvents(agent, makeInput({ state: { edited: true } }));

      const memoryRequests = requests.filter(({ url }) =>
        url.pathname.includes("/memory/"),
      );
      expect(
        memoryRequests.map(({ url }) => url.searchParams.get("agentId")),
      ).toEqual(["public-agent", "public-agent"]);
      // The per-run handle is the shared handle with a new signal.
      expect(requests.at(-1)?.url.pathname).toBe(
        "/api/agents/native-agent/stream",
      );
    },
  );

  it.each(["native-agent", "assistant"])(
    "streams through the handle and aborts its fetch on cancel (config agentId %j)",
    async (configAgentId) => {
      const paths: string[] = [];
      let fetchSignal: AbortSignal | undefined;
      const fetch: typeof globalThis.fetch = async (input, init) => {
        const request = new Request(input, init);
        const { pathname } = new URL(request.url);
        paths.push(pathname);
        if (pathname !== "/api/agents/native-agent/stream") {
          return Response.json({ error: "Not found" }, { status: 404 });
        }
        fetchSignal = init?.signal ?? undefined;
        const signal = fetchSignal;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                'data: {"type":"text-delta","payload":{"text":"hi"}}\n\n',
              ),
            );
            signal?.addEventListener("abort", () =>
              controller.error(new DOMException("Aborted", "AbortError")),
            );
          },
        });
        return new Response(body, {
          headers: { "content-type": "text/event-stream" },
        });
      };
      const client = new MastraClient({
        baseUrl: "http://mastra.test",
        retries: 0,
        fetch,
      });
      const agent = new MastraAgent({
        agentId: configAgentId,
        agent: client.getAgent("native-agent"),
        resourceId: "resource-1",
        remoteClient: client,
      });

      let error: unknown;
      let settle = () => {};
      const firstChunk = new Promise<void>((resolve) => {
        settle = resolve;
      });
      const subscription = agent
        .run(
          makeInput({
            messages: [{ id: "1", role: "user", content: "Hi" }] as any,
          }),
        )
        .subscribe({
          next: (event) => {
            if (event.type === "TEXT_MESSAGE_CHUNK") settle();
          },
          error: (err) => {
            error = err;
            settle();
          },
          complete: () => settle(),
        });
      await firstChunk;

      expect(error).toBeUndefined();
      expect(paths).toEqual(["/api/agents/native-agent/stream"]);
      expect(fetchSignal?.aborted).toBe(false);

      subscription.unsubscribe();
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(fetchSignal?.aborted).toBe(true);
    },
  );
});

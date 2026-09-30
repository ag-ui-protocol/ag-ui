import { HttpAgent } from "../http";
import { EventType } from "@ag-ui/core";
import { describe, it, expect, vi } from "vitest";

const sse = (...events: object[]) =>
  new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });

const historyReply = () =>
  sse(
    { type: EventType.RUN_STARTED, threadId: "t1", runId: "replay" },
    {
      type: EventType.MESSAGES_SNAPSHOT,
      messages: [
        { id: "m1", role: "user", content: "Hello" },
        { id: "m2", role: "assistant", content: "Hi there" },
      ],
    },
    { type: EventType.STATE_SNAPSHOT, snapshot: { step: 2 } },
    { type: EventType.RUN_FINISHED, threadId: "t1", runId: "replay" },
  );

describe("HttpAgent connect", () => {
  it("replays thread history from POST {url}/connect", async () => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => historyReply());
    const agent = new HttpAgent({ url: "https://api.example.com/agent", threadId: "t1", fetch });

    await agent.connectAgent();

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://api.example.com/agent/connect");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string).threadId).toBe("t1");
    expect(agent.messages.map((m) => m.content)).toEqual(["Hello", "Hi there"]);
    expect(agent.state).toEqual({ step: 2 });
  });

  it.each([
    ["http://localhost:8000/", "http://localhost:8000/connect"],
    ["https://api.example.com/agent/?key=1", "https://api.example.com/agent/connect?key=1"],
    ["/api/agent", "/api/agent/connect"],
  ])("derives the connect URL from %s", async (agentUrl, expected) => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => historyReply());
    const agent = new HttpAgent({ url: agentUrl, threadId: "t1", fetch });

    await agent.connectAgent();

    expect(fetch.mock.calls[0][0]).toBe(expected);
  });

  it.each([404, 405])("resolves empty when the server answers %i", async (status) => {
    const fetch = vi.fn(async () => new Response("Not Found", { status }));
    const agent = new HttpAgent({ url: "https://api.example.com/agent", threadId: "t1", fetch });

    const result = await agent.connectAgent();

    expect(result.newMessages).toEqual([]);
    expect(agent.messages).toEqual([]);
  });

  it("surfaces other server errors to the caller", async () => {
    const fetch = vi.fn(async () => new Response("boom", { status: 500 }));
    const onRunFailed = vi.fn();
    const agent = new HttpAgent({ url: "https://api.example.com/agent", threadId: "t1", fetch });

    await agent.connectAgent({}, { onRunFailed }).catch(() => {});

    expect(onRunFailed).toHaveBeenCalledTimes(1);
    expect(String(onRunFailed.mock.calls[0][0].error)).toContain("HTTP 500");
  });
});

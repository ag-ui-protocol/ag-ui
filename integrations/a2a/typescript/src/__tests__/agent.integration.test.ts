import { A2AAgent } from "../agent";
import { A2AClient } from "@a2a-js/sdk/client";
import type { BaseEvent, Message } from "@ag-ui/client";
import { EventType } from "@ag-ui/client";
import { ENGRAM_EXTENSION_URI } from "../utils";

const createMessage = (message: Partial<Message>): Message => message as Message;

const encoder = new TextEncoder();

const createSseResponse = (events: unknown[], rpcId: number) =>
  new Response(
    new ReadableStream({
      start(controller) {
        for (const event of events) {
          const payload = JSON.stringify({
            jsonrpc: "2.0",
            id: rpcId,
            result: event,
          });
          controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
        }
        controller.close();
      },
    }),
    {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    },
  );

describe("A2AAgent integration with real A2AClient", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  it("streams SSE events, projecting text/status/artifacts into AG-UI state", async () => {
    const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/.well-known/agent.json")) {
        return new Response(
          JSON.stringify({
            url: "https://agent.local/rpc",
            capabilities: { streaming: true },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      if (url.endsWith("/rpc")) {
        const headers = new Headers(init?.headers);
        const body = init?.body ? JSON.parse(init.body as string) : {};
        const method = typeof body.method === "string" ? body.method : "";

        if (method === "tasks/get") {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id ?? 1,
              result: {
                kind: "task",
                id: body.params?.id ?? "task-stream",
                contextId: "ctx-stream",
                status: { state: "working" },
                history: [
                  {
                    kind: "message",
                    messageId: "history-1",
                    role: "agent",
                    parts: [{ kind: "text", text: "Snapshot output" }],
                  },
                ],
                artifacts: [],
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        if (headers.get("Accept")?.includes("text/event-stream")) {
          const rpcId = typeof body.id === "number" ? body.id : 1;
          const streamEvents = [
            {
              kind: "message" as const,
              messageId: "stream-msg",
              role: "agent" as const,
              parts: [{ kind: "text" as const, text: "Hello stream" }],
              contextId: "ctx-stream",
              taskId: "task-stream",
            },
            {
              kind: "status-update" as const,
              contextId: "ctx-stream",
              taskId: "task-stream",
              final: false,
              status: {
                state: "working" as const,
                message: {
                  kind: "message" as const,
                  messageId: "status-msg",
                  role: "agent" as const,
                  parts: [{ kind: "text" as const, text: "Working" }],
                },
                timestamp: "now",
              },
            },
            {
              kind: "artifact-update" as const,
              contextId: "ctx-stream",
              taskId: "task-stream",
              append: false,
              lastChunk: true,
              artifact: {
                artifactId: "artifact-stream",
                parts: [{ kind: "data" as const, data: { foo: "bar" } }],
              },
            },
          ];

          return createSseResponse(streamEvents, rpcId);
        }

        throw new Error(`Unhandled RPC call: ${init?.body}`);
      }

      throw new Error(`Unhandled fetch URL: ${url}`);
    });

    global.fetch = fetchMock as typeof fetch;

    const client = new A2AClient("https://agent.local");
    const agent = new A2AAgent({
      a2aClient: client,
      initialMessages: [createMessage({ id: "user-1", role: "user", content: "Start streaming" })],
      initialState: { view: { tasks: {}, artifacts: {} } },
    });

    const observedEvents: BaseEvent[] = [];

    // Given an existing task with streaming enabled
    // When the agent streams A2A events
    const result = await agent.runAgent(
      {
        forwardedProps: {
          a2a: { mode: "stream", taskId: "task-stream", contextId: "ctx-stream" },
        },
      },
      {
        onEvent: ({ event }) => {
      observedEvents.push(event);
    },
      },
    );

    // Then stream text is emitted as assistant output
    expect(result.newMessages.some((message) => String(message.content).includes("Hello stream"))).toBe(
      true,
    );

    // Then status and artifact projections land in shared state
    expect(
      (agent.state as { view?: { tasks?: Record<string, unknown> } }).view?.tasks?.["task-stream"],
    ).toEqual(
      expect.objectContaining({
        status: expect.objectContaining({ state: "working" }),
      }),
    );
    expect(
      (agent.state as { view?: { artifacts?: Record<string, unknown> } }).view?.artifacts?.[
        "artifact-stream"
      ],
    ).toEqual({ foo: "bar" });

    // Then AG-UI events contain text, status, and state deltas
    expect(
      observedEvents.some(
        (event) =>
          event.type === EventType.TEXT_MESSAGE_CONTENT &&
          "delta" in event &&
          (event as { delta?: unknown }).delta === "Hello stream",
      ),
    ).toBe(true);
    expect(observedEvents.some((event) => event.type === EventType.STATE_DELTA)).toBe(true);

    // Then Engram extension header is sent on streaming requests
    const streamCall = fetchMock.mock.calls.find(([, init]) =>
      new Headers(init?.headers).get("Accept")?.includes("text/event-stream"),
    );
    const streamHeaders = new Headers(streamCall?.[1]?.headers);
    expect(streamHeaders.get("X-A2A-Extensions")).toContain(ENGRAM_EXTENSION_URI);
    expect(streamHeaders.get("Accept")).toContain("text/event-stream");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(".well-known/agent.json"),
      expect.any(Object),
    );
  });

  it("uses real JSON-RPC send to deliver control runs without leaking AG-UI IDs", async () => {
    const rpcBodies: Array<Record<string, unknown>> = [];
    const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/.well-known/agent.json")) {
        return new Response(
          JSON.stringify({
            url: "https://agent.local/rpc",
            capabilities: { streaming: true },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      if (url.endsWith("/rpc")) {
        const parsedBody = init?.body ? JSON.parse(init.body as string) : {};
        rpcBodies.push(parsedBody);

        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: parsedBody.id ?? 1,
            result: {
              kind: "message",
              messageId: "send-msg",
              role: "agent",
              parts: [{ kind: "text", text: "Control acknowledged" }],
              contextId: "ctx-control",
              taskId: "task-control",
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      throw new Error(`Unhandled fetch URL: ${url}`);
    });

    global.fetch = fetchMock as typeof fetch;

    const client = new A2AClient("https://agent.local");
    const agent = new A2AAgent({
      a2aClient: client,
      initialMessages: [
        createMessage({ id: "user-1", role: "user", content: "Adjust settings" }),
        createMessage({ id: "assistant-1", role: "assistant", content: "Working" }),
      ],
      initialState: { view: { tasks: {}, artifacts: {} } },
    });

    // Given a control run targeting an existing task
    // When sending via JSON-RPC (blocking mode)
    const result = await agent.runAgent({
      forwardedProps: { a2a: { mode: "send", taskId: "task-control" } },
      runId: "run-hidden",
    });

    // Then assistant output is delivered and state is untouched
    expect(result.newMessages.some((message) => String(message.content).includes("Control"))).toBe(
      true,
    );
    expect(agent.state).toEqual({ view: { tasks: {}, artifacts: {} } });

    // Then payload uses context/task IDs and never leaks thread/run IDs
    const rpcPayload = rpcBodies.find((body) => body.method === "message/send") as {
      params?: { metadata?: Record<string, unknown>; message?: { contextId?: string; taskId?: string } };
    };
    expect(rpcPayload?.params?.message?.taskId).toBe("task-control");
    expect(rpcPayload?.params?.message?.contextId).toBe("task-control");
    expect(rpcPayload?.params?.metadata).toEqual(
      expect.objectContaining({
        mode: "send",
        taskId: "task-control",
        contextId: "task-control",
      }),
    );
    expect(rpcPayload?.params?.metadata).not.toHaveProperty("threadId");
    expect(rpcPayload?.params?.metadata).not.toHaveProperty("runId");

    // Then history and artifact defaults are forwarded
    const history = rpcPayload?.params?.metadata?.history as unknown[];
    expect(Array.isArray(history) ? history.length : 0).toBeGreaterThan(1);

    const rpcHeaders = new Headers(fetchMock.mock.calls[1]?.[1]?.headers);
    expect(rpcHeaders.get("X-A2A-Extensions")).toContain(ENGRAM_EXTENSION_URI);
    expect(rpcHeaders.get("Content-Type")).toBe("application/json");
  });

  it("streams legacy text-only agent output without emitting shared-state deltas", async () => {
    const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/.well-known/agent.json")) {
        return new Response(
          JSON.stringify({
            url: "https://agent.local/rpc",
            capabilities: { streaming: true },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (url.endsWith("/rpc")) {
        const body = init?.body ? JSON.parse(init.body as string) : {};
        const method = typeof body.method === "string" ? body.method : "";

        if (method === "message/stream") {
          const rpcId = typeof body.id === "number" ? body.id : 1;
          const streamEvents = [
            {
              kind: "message" as const,
              messageId: "legacy-text",
              role: "agent" as const,
              parts: [{ kind: "text" as const, text: "Hello legacy" }],
            },
          ];

          return new Response(
            new ReadableStream({
              start(controller) {
                for (const event of streamEvents) {
                  controller.enqueue(
                    new TextEncoder().encode(
                      `data: ${JSON.stringify({ jsonrpc: "2.0", id: rpcId, result: event })}\n\n`,
                    ),
                  );
                }
                controller.close();
              },
            }),
            { status: 200, headers: { "Content-Type": "text/event-stream" } },
          );
        }

        throw new Error(`Unhandled RPC method: ${method}`);
      }

      throw new Error(`Unhandled fetch URL: ${url}`);
    });

    global.fetch = fetchMock as typeof fetch;

    const client = new A2AClient("https://agent.local");
    const agent = new A2AAgent({
      a2aClient: client,
      initialMessages: [createMessage({ id: "u1", role: "user", content: "hi" })],
      initialState: { view: { tasks: {}, artifacts: {} } },
    });

    const observedEvents: BaseEvent[] = [];

    await agent.runAgent(
      {
        forwardedProps: { a2a: { mode: "stream" } },
      },
      {
        onEvent: ({ event }) => {
          observedEvents.push(event);
        },
      },
    );

    const textEvents = observedEvents.filter((event) =>
      event.type === EventType.TEXT_MESSAGE_CONTENT || event.type === EventType.TEXT_MESSAGE_CHUNK,
    );
    expect(
      textEvents.some((event) => (event as { delta?: unknown }).delta === "Hello legacy"),
    ).toBe(true);
    expect(observedEvents.some((event) => event.type === EventType.STATE_DELTA)).toBe(false);
    expect(agent.state).toEqual({ view: { tasks: {}, artifacts: {} } });
  });
});

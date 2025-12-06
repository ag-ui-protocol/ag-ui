import type { BaseEvent, Message } from "@ag-ui/client";
import { EventType } from "@ag-ui/client";
import { A2AAgent } from "../agent";
import type { MessageSendParams } from "@a2a-js/sdk";
import type { A2AClient } from "@a2a-js/sdk/client";
import { ENGRAM_EXTENSION_URI } from "../utils";

const createMessage = (message: Partial<Message>): Message => message as Message;

type SendMessageResponseSuccess = {
  id: string | number | null;
  jsonrpc: "2.0";
  result: unknown;
};

type SendMessageResponseError = {
  id: string | number | null;
  jsonrpc: "2.0";
  error: { code: number; message: string };
};

type FakeA2AClientBehaviour = {
  stream?: (params: MessageSendParams) => AsyncGenerator<unknown, void, unknown>;
  send?: (params: MessageSendParams) => Promise<SendMessageResponseSuccess | SendMessageResponseError>;
  card?: () => Promise<unknown>;
  getTask?: (params: { id: string; historyLength?: number; contextId?: string }) => Promise<SendMessageResponseSuccess | SendMessageResponseError>;
  resubscribeTask?: (params: { id: string; contextId?: string }) => AsyncGenerator<unknown, void, unknown>;
};

type FakeA2AClientResponse = SendMessageResponseSuccess | SendMessageResponseError;

class FakeA2AClient {
  public readonly sendCalls: MessageSendParams[] = [];
  public readonly streamCalls: MessageSendParams[] = [];
  public readonly getTaskCalls: Array<{ id: string; historyLength?: number; contextId?: string }> = [];
  public readonly resubscribeCalls: Array<{ id: string; contextId?: string }> = [];

  constructor(readonly behaviour: FakeA2AClientBehaviour = {}) {}

  sendMessageStream(params: MessageSendParams) {
    this.streamCalls.push(params);
    if (!this.behaviour.stream) {
      throw new Error("Streaming not configured");
    }
    return this.behaviour.stream(params);
  }

  async sendMessage(params: MessageSendParams) {
    this.sendCalls.push(params);
    if (!this.behaviour.send) {
      throw new Error("sendMessage not configured");
    }
    return this.behaviour.send(params);
  }

  async getTask(params: { id: string; historyLength?: number; contextId?: string }) {
    this.getTaskCalls.push(params);
    if (!this.behaviour.getTask) {
      throw new Error("getTask not configured");
    }

    return this.behaviour.getTask(params);
  }

  resubscribeTask(params: { id: string; contextId?: string }) {
    this.resubscribeCalls.push(params);
    if (!this.behaviour.resubscribeTask) {
      throw new Error("resubscribeTask not configured");
    }
    return this.behaviour.resubscribeTask(params);
  }

  isErrorResponse(response: FakeA2AClientResponse): response is SendMessageResponseError {
    return "error" in response && Boolean(response.error);
  }

  async getAgentCard() {
    if (this.behaviour.card) {
      return this.behaviour.card();
    }
    return {
      name: "Test Agent",
      description: "",
      capabilities: {
        extensions: [
          {
            uri: ENGRAM_EXTENSION_URI,
          },
        ],
      },
    };
  }
}

describe("A2AAgent", () => {
  it("streams responses and records run summary", async () => {
    const fakeClient = new FakeA2AClient({
      stream: async function* () {
        yield {
          kind: "message",
          messageId: "resp-1",
          role: "agent",
          parts: [{ kind: "text", text: "Hello from stream" }],
        };
      },
    });

    const agent = new A2AAgent({
      a2aClient: fakeClient as unknown as A2AClient,
      initialMessages: [
        createMessage({
          id: "user-1",
          role: "user",
          content: "Hi there",
        }),
      ],
    });

    const result = await agent.runAgent();

    expect(result.result).toBeUndefined();

    expect(result.newMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "assistant" }),
      ]),
    );
  });

  it("falls back to blocking when streaming fails", async () => {
    const fakeClient = new FakeA2AClient({
      stream: async () => {
        throw new Error("Streaming unsupported");
      },
      send: async () => ({
        id: null,
        jsonrpc: "2.0",
        result: {
          kind: "message",
          messageId: "resp-2",
          role: "agent",
          parts: [{ kind: "text", text: "Blocking response" }],
        },
      }),
    });

    const agent = new A2AAgent({
      a2aClient: fakeClient as unknown as A2AClient,
      initialMessages: [
        createMessage({ id: "user-1", role: "user", content: "Ping" }),
      ],
    });

    const result = await agent.runAgent();

    expect(result.result).toBeUndefined();
  });

  it("throws when the A2A service reports an error", async () => {
    const fakeClient = new FakeA2AClient({
      stream: async () => {
        throw new Error("Streaming unsupported");
      },
      send: async () => ({
        id: null,
        jsonrpc: "2.0",
        error: { code: -32000, message: "Agent failure" },
      }),
    });

    const agent = new A2AAgent({
      a2aClient: fakeClient as unknown as A2AClient,
      initialMessages: [
        createMessage({ id: "user-1", role: "user", content: "Trouble" }),
      ],
    });

    await expect(agent.runAgent()).rejects.toThrow("Agent failure");
  });

  it("uses blocking send for control runs and keeps AG-UI identifiers out of A2A metadata", async () => {
    const fakeClient = new FakeA2AClient({
      send: async () => ({
        id: null,
        jsonrpc: "2.0",
        result: {
          kind: "message",
          messageId: "resp-control",
          role: "agent",
          parts: [{ kind: "text", text: "Control ack" }],
        },
      }),
    });

    const agent = new A2AAgent({
      a2aClient: fakeClient as unknown as A2AClient,
      threadId: "thread-internal",
      initialMessages: [
        createMessage({ id: "user-1", role: "user", content: "Start a task" }),
        createMessage({ id: "assistant-1", role: "assistant", content: "Working" }),
      ],
    });

    await agent.runAgent({
      runId: "run-hidden",
      forwardedProps: {
        a2a: { mode: "send", taskId: "task-789", historyLength: 5 },
      },
    });

    expect(fakeClient.streamCalls).toHaveLength(0);
    expect(fakeClient.sendCalls).toHaveLength(1);

    const params = fakeClient.sendCalls[0];
    const metadata = params.metadata as Record<string, unknown>;

    expect(params.message?.contextId).toBeUndefined();
    expect(params.message?.taskId).toBe("task-789");
    expect(metadata).toEqual(
      expect.objectContaining({
        mode: "send",
        taskId: "task-789",
      }),
    );
    expect(metadata).not.toHaveProperty("contextId");
    expect(metadata).not.toHaveProperty("threadId");
    expect(metadata).not.toHaveProperty("runId");
  });

  it("forwards context and config metadata without exposing thread or run identifiers", async () => {
    const fakeClient = new FakeA2AClient({
      send: async (params) => ({
        id: null,
        jsonrpc: "2.0",
        result: {
          kind: "message",
          messageId: "resp-metadata",
          role: "agent",
          parts: [{ kind: "text", text: "Control ack" }],
          contextId: params.message?.contextId,
          taskId: params.message?.taskId,
        },
      }),
    });

    const agent = new A2AAgent({
      a2aClient: fakeClient as unknown as A2AClient,
      threadId: "thread-forwarding",
      engram: { enabled: true },
      initialMessages: [
        createMessage({ id: "sys-1", role: "system", content: "guardrails" }),
        createMessage({ id: "dev-1", role: "developer", content: "dev hints" }),
        createMessage({ id: "user-1", role: "user", content: "start task" }),
      ],
    });

    await agent.runAgent({
      context: [{ description: "region", value: "us-west" }],
      forwardedProps: {
        a2a: {
          mode: "send",
          includeSystemMessages: true,
          includeDeveloperMessages: true,
          engramUpdate: { scope: "task", update: { feature: true } },
          engram: true,
        },
      },
    });

    const params = fakeClient.sendCalls[0];
    expect(params.message?.contextId).toBeUndefined();
    expect(params.metadata?.history).toBeUndefined();
    expect(params.message?.metadata?.history).toBeUndefined();
    expect(params.message?.metadata?.context).toEqual([{ description: "region", value: "us-west" }]);
    expect(params.message?.metadata?.engram).toEqual({ scope: "task", update: { feature: true } });
    expect(params.metadata).not.toHaveProperty("contextId");
    expect(params.metadata).not.toHaveProperty("threadId");
    expect(params.metadata).not.toHaveProperty("runId");
  });

  it("late-binds threadId to the server contextId and forwards it on subsequent sends", async () => {
    const fakeClient = new FakeA2AClient({
      stream: async function* () {
        yield {
          kind: "message",
          messageId: "resp-context",
          role: "agent",
          parts: [{ kind: "text", text: "ack" }],
          contextId: "ctx-server",
          taskId: "task-server",
        };
        yield {
          kind: "status-update",
          taskId: "task-server",
          contextId: "ctx-server",
          final: true,
          status: { state: "succeeded" },
        };
      },
      send: async (params) => ({
        id: null,
        jsonrpc: "2.0",
        result: {
          kind: "message",
          messageId: "resp-followup",
          role: "agent",
          parts: [{ kind: "text", text: "follow up" }],
          contextId: params.message?.contextId,
          taskId: params.message?.taskId,
        },
      }),
    });

    const agent = new A2AAgent({
      a2aClient: fakeClient as unknown as A2AClient,
      threadId: "thread-context-order",
      initialMessages: [createMessage({ id: "user-1", role: "user", content: "hi" })],
    });

    const events: BaseEvent[] = [];

    await agent.runAgent(
      {
        forwardedProps: {
          a2a: { mode: "stream" },
        },
      },
      { onEvent: ({ event }) => events.push(event) },
    );

    const runStarted = events.find((event) => event.type === EventType.RUN_STARTED) as
      | { threadId?: string }
      | undefined;
    expect(events[0]?.type).toBe(EventType.RUN_STARTED);
    expect(runStarted?.threadId).toBe("ctx-server");
    expect(fakeClient.streamCalls[0]?.message?.contextId).toBeUndefined();

    await agent.runAgent({
      forwardedProps: {
        a2a: { mode: "send" },
      },
    });

    const secondSend = fakeClient.sendCalls[0];
    const metadata = secondSend?.metadata as Record<string, unknown> | undefined;
    expect(secondSend?.message?.contextId).toBe("ctx-server");
    expect(metadata?.contextId).toBe("ctx-server");
  });

  it("emits RUN_STARTED immediately when caller supplies a contextId and forwards it on outbound streams", async () => {
    const fakeClient = new FakeA2AClient({
      stream: async function* () {
        yield {
          kind: "status-update",
          taskId: "task-provided",
          contextId: "ctx-provided",
          final: true,
          status: { state: "succeeded" },
        };
      },
    });

    const agent = new A2AAgent({
      a2aClient: fakeClient as unknown as A2AClient,
      initialMessages: [createMessage({ id: "user-prov", role: "user", content: "go" })],
    });

    const events: BaseEvent[] = [];
    await agent.runAgent(
      {
        forwardedProps: { a2a: { mode: "stream", contextId: "ctx-provided" } },
      },
      { onEvent: ({ event }) => events.push(event) },
    );

    const runStarted = events[0] as { type?: EventType; threadId?: string };
    expect(runStarted.type).toBe(EventType.RUN_STARTED);
    expect(runStarted.threadId).toBe("ctx-provided");
    expect(fakeClient.streamCalls[0]?.message?.contextId).toBe("ctx-provided");
    expect(fakeClient.streamCalls[0]?.metadata?.contextId).toBe("ctx-provided");
  });

  it("binds the server contextId using resolveThreadIdOnce when none is provided", async () => {
    const fakeClient = new FakeA2AClient({
      stream: async function* () {
        yield {
          kind: "message",
          messageId: "resp-context",
          role: "agent",
          parts: [{ kind: "text", text: "hi" }],
          contextId: "ctx-bind",
          taskId: "task-bind",
        };
        yield {
          kind: "status-update",
          taskId: "task-bind",
          contextId: "ctx-bind",
          final: true,
          status: { state: "succeeded" },
        };
      },
    });

    const agent = new A2AAgent({
      a2aClient: fakeClient as unknown as A2AClient,
      initialMessages: [createMessage({ id: "user-ctx", role: "user", content: "bind" })],
    });

    const resolveSpy = jest.spyOn(agent as unknown as { resolveThreadIdOnce: (id: string) => string }, "resolveThreadIdOnce");
    const events: BaseEvent[] = [];

    await agent.runAgent(
      {
        forwardedProps: { a2a: { mode: "stream" } },
      },
      {
        onEvent: ({ event }) => events.push(event),
      },
    );

    const runStarted = events.find((event) => event.type === EventType.RUN_STARTED) as { threadId?: string } | undefined;
    const runFinished = events.find((event) => event.type === EventType.RUN_FINISHED) as { threadId?: string } | undefined;

    expect(resolveSpy).toHaveBeenCalledWith("ctx-bind");
    expect(runStarted?.threadId).toBe("ctx-bind");
    expect(runFinished?.threadId).toBe("ctx-bind");
    expect(agent.threadId).toBe("ctx-bind");

    resolveSpy.mockRestore();
  });

  it("emits RUN_ERROR with a provisional threadId when an error occurs before contextId binding", async () => {
    const fakeClient = new FakeA2AClient({
      send: async () => ({
        id: null,
        jsonrpc: "2.0",
        error: { code: -32000, message: "Agent failure" },
      }),
      stream: async () => {
        throw new Error("stream failure");
      },
    });

    const agent = new A2AAgent({
      a2aClient: fakeClient as unknown as A2AClient,
      initialMessages: [createMessage({ id: "user-err", role: "user", content: "fail fast" })],
    });

    const resolveSpy = jest.spyOn(agent as unknown as { resolveThreadIdOnce: (id: string) => string }, "resolveThreadIdOnce");
    const events: BaseEvent[] = [];

    try {
      await agent.runAgent(
        {
          runId: "run-error",
          forwardedProps: { a2a: { mode: "send" } },
        },
        { onEvent: ({ event }) => events.push(event) },
      );
    } catch {
      // Expected: propagate error after emitting RUN_ERROR
    }

    const runStarted = events.find((event) => event.type === EventType.RUN_STARTED) as { threadId?: string } | undefined;
    const eventTypes = events.map((event) => event.type);

    expect(runStarted?.threadId).toBe("run-error");
    expect(eventTypes[0]).toBe(EventType.RUN_STARTED);
    expect(eventTypes.filter((type) => type === EventType.RUN_STARTED)).toHaveLength(1);
    expect(agent.threadId).toBe("");
    expect(resolveSpy).not.toHaveBeenCalled();
    resolveSpy.mockRestore();
  });

  it("resubscribes to existing tasks using snapshots instead of reopening runs", async () => {
    const fakeClient = new FakeA2AClient({
      getTask: async (params) => ({
        id: null,
        jsonrpc: "2.0",
        result: {
          kind: "task",
          id: params.id,
          contextId: "ctx-resume",
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
      resubscribeTask: async function* () {
        yield {
          kind: "status-update",
          taskId: "task-resume",
          contextId: "ctx-resume",
          final: false,
          status: {
            state: "working",
            message: {
              kind: "message",
              messageId: "status-1",
              role: "agent",
              parts: [{ kind: "text", text: "Still running" }],
            },
            timestamp: "now",
          },
        };
      },
      send: async () => {
        throw new Error("sendMessage should not be used when resubscribing");
      },
    });

    const agent = new A2AAgent({
      a2aClient: fakeClient as unknown as A2AClient,
      initialMessages: [],
    });

    const result = await agent.runAgent({
      forwardedProps: {
        a2a: { mode: "stream", taskId: "task-resume", historyLength: 2 },
      },
    });

    expect(fakeClient.sendCalls).toHaveLength(0);
    expect(fakeClient.getTaskCalls).toEqual([
      expect.objectContaining({ id: "task-resume", historyLength: 2 }),
    ]);
    expect(fakeClient.resubscribeCalls).toEqual([expect.objectContaining({ id: "task-resume" })]);

    const combinedText = result.newMessages.map((message) => String(message.content)).join(" ");
    expect(combinedText).toContain("Snapshot output");
    expect(combinedText).toContain("Still running");
  });

  it("advertises the Engram extension header on outbound A2A requests", async () => {
    const originalFetch = global.fetch;
    const fetchMock = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
    })) as jest.MockedFunction<typeof fetch>;

    global.fetch = fetchMock;

    const fakeClient = new FakeA2AClient({
      send: async () => {
        await fetch("https://example.invalid/a2a", {
          headers: new Headers({
            "X-Existing": "true",
            "X-A2A-Extensions": "custom-ext",
          }),
        });
        return {
          id: null,
          jsonrpc: "2.0",
          result: {
            kind: "message",
            messageId: "resp-headers",
            role: "agent",
            parts: [{ kind: "text", text: "ok" }],
          },
        };
      },
    });

    const agent = new A2AAgent({
      a2aClient: fakeClient as unknown as A2AClient,
      initialMessages: [createMessage({ id: "user-1", role: "user", content: "ping" })],
    });

    try {
      await agent.runAgent({
        forwardedProps: {
          a2a: { mode: "send" },
        },
      });
    } finally {
      global.fetch = originalFetch;
    }

    expect(fetchMock).toHaveBeenCalled();
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Headers | undefined;

    expect(headers?.get("X-Existing")).toBe("true");
    expect(headers?.get("X-A2A-Extensions")).toBe("custom-ext");
  });

  it("stops streaming and emits interrupt run finish on input-required status", async () => {
    const fakeClient = new FakeA2AClient({
      stream: async function* () {
        yield {
          kind: "status-update",
          taskId: "task-input",
          contextId: "ctx-input",
          final: false,
          status: {
            state: "input-required",
            message: {
              kind: "message",
              messageId: "status-input",
              role: "agent",
              parts: [
                { kind: "text", text: "Need approval" },
                { kind: "data", data: { type: "a2a.input.request", requestId: "request-abc" } },
              ],
            },
          },
        };
        yield {
          kind: "message",
          messageId: "post-interrupt",
          role: "agent",
          parts: [{ kind: "text", text: "should not appear" }],
        };
      },
      getTask: async (params) => ({
        id: null,
        jsonrpc: "2.0",
        result: {
          kind: "task",
          id: params.id,
          contextId: "ctx-input",
          status: { state: "working" },
          history: [],
          artifacts: [],
        },
      }),
    });

    const agent = new A2AAgent({
      a2aClient: fakeClient as unknown as A2AClient,
      initialMessages: [createMessage({ id: "user-1", role: "user", content: "Start" })],
    });

    const observed: BaseEvent[] = [];

    await agent.runAgent(
      {
        forwardedProps: { a2a: { mode: "stream", taskId: "task-input", subscribeOnly: false } },
      },
      { onEvent: ({ event }) => observed.push(event) },
    );

    const runFinished = observed.find((event) => event.type === EventType.RUN_FINISHED) as
      | { result?: Record<string, unknown> }
      | undefined;
    const deltas = observed
      .filter(
        (event) =>
          event.type === EventType.TEXT_MESSAGE_CHUNK ||
          event.type === EventType.TEXT_MESSAGE_CONTENT,
      )
      .map((event) => (event as { delta?: string }).delta);

    expect(runFinished?.result).toEqual(
      expect.objectContaining({ outcome: "interrupt", taskId: "task-input" }),
    );
    expect(deltas).toContain("Need approval");
    expect(deltas).not.toContain("should not appear");
  });
});

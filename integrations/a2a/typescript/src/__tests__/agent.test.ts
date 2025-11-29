import type { Message } from "@ag-ui/client";
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
  getTask?: (params: { id: string; historyLength?: number }) => Promise<SendMessageResponseSuccess | SendMessageResponseError>;
  resubscribeTask?: (params: { id: string }) => AsyncGenerator<unknown, void, unknown>;
};

type FakeA2AClientResponse = SendMessageResponseSuccess | SendMessageResponseError;

class FakeA2AClient {
  public readonly sendCalls: MessageSendParams[] = [];
  public readonly streamCalls: MessageSendParams[] = [];
  public readonly getTaskCalls: Array<{ id: string; historyLength?: number }> = [];
  public readonly resubscribeCalls: Array<{ id: string }> = [];

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

  async getTask(params: { id: string; historyLength?: number }) {
    this.getTaskCalls.push(params);
    if (!this.behaviour.getTask) {
      throw new Error("getTask not configured");
    }

    return this.behaviour.getTask(params);
  }

  resubscribeTask(params: { id: string }) {
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
      capabilities: {},
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
      stream: async function* () {
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
      stream: async function* () {
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
      send: async (params) => ({
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

    expect(params.message?.contextId).toBe("task-789");
    expect(params.message?.taskId).toBe("task-789");
    expect(metadata).toEqual(
      expect.objectContaining({
        mode: "send",
        taskId: "task-789",
        contextId: "task-789",
      }),
    );
    expect(metadata).not.toHaveProperty("threadId");
    expect(metadata).not.toHaveProperty("runId");

    const history = metadata.history as unknown[];
    expect(Array.isArray(history) ? history.length : 0).toBeGreaterThan(1);
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
    const fetchMock = jest.fn(async (_input: RequestInfo | URL, init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => ({}),
    })) as jest.MockedFunction<typeof fetch>;

    global.fetch = fetchMock;

    const fakeClient = new FakeA2AClient({
      send: async () => {
        await fetch("https://example.invalid/a2a", {
          headers: new Headers({ "X-Existing": "true" }),
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
    expect(headers?.get("X-A2A-Extensions")).toContain(ENGRAM_EXTENSION_URI);
  });
});

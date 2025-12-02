import http from "http";
import { A2AAgent } from "../agent";
import { A2AClient } from "@a2a-js/sdk/client";
import type { AddressInfo } from "net";
import type { BaseEvent, Message } from "@ag-ui/client";
import { EventType } from "@ag-ui/client";
import { ENGRAM_EXTENSION_URI } from "../utils";

const createMessage = (message: Partial<Message>): Message => message as Message;

jest.setTimeout(30000);

type TestServer = {
  baseUrl: string;
  close: () => Promise<void>;
  getRpcCalls: () => Array<{ method: string; body: unknown; headers: http.IncomingHttpHeaders }>;
  resetRpcCalls: () => void;
};

const startA2AServer = async (): Promise<TestServer> => {
  let server: http.Server;
  let baseUrl: string;
  const rpcCalls: Array<{ method: string; body: unknown; headers: http.IncomingHttpHeaders }> = [];

  const handler = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = req.url ?? "";
    const method = req.method ?? "GET";

    if (method === "GET" && url === "/.well-known/agent.json") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          url: `${baseUrl}/rpc`,
          capabilities: { streaming: true },
          name: "local-e2e-agent",
          description: "Local A2A test server",
        }),
      );
      return;
    }

    if (method === "POST" && url === "/rpc") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const bodyString = Buffer.concat(chunks).toString("utf-8") || "{}";
        const body = JSON.parse(bodyString) as { id?: number; method?: string; params?: any };
        const rpcId = body.id ?? 1;
        rpcCalls.push({ method: body.method ?? "", body, headers: req.headers });

        if (body.method === "message/send") {
          const requestedTaskId = body.params?.message?.taskId ?? body.params?.metadata?.taskId ?? "task-e2e";
          const requestedContextId =
            body.params?.message?.contextId ?? body.params?.metadata?.contextId ?? "ctx-e2e";
          const parts = (body.params?.message?.parts ?? []) as Array<
            { kind?: string; data?: { type?: string; [key: string]: unknown } }
          >;
          const hasFormResponse = parts.some((part) => part.data?.type === "a2a.hitl.formResponse");
          if (hasFormResponse) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: rpcId,
                result: {
                  kind: "status-update" as const,
                  contextId: requestedContextId,
                  taskId: requestedTaskId,
                  final: true,
                  status: {
                    state: "succeeded" as const,
                    message: {
                      kind: "message",
                      messageId: "status-resumed",
                      role: "agent",
                      parts: [{ kind: "text", text: "Resumed and completed" }],
                    },
                    timestamp: new Date().toISOString(),
                  },
                },
              }),
            );
            return;
          }
          const { message } = body.params ?? {};
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: rpcId,
              result: {
                kind: "message",
                messageId: "e2e-send",
                role: "agent",
                parts: [{ kind: "text", text: `Echo: ${message?.parts?.[0]?.text ?? "ping"}` }],
                contextId: requestedContextId,
                taskId: requestedTaskId,
              },
            }),
          );
          return;
        }

        if (body.method === "tasks/get") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: rpcId,
              result: {
                kind: "task",
                id: body.params?.id ?? "task-e2e",
                contextId: "ctx-e2e",
                status: { state: "working" },
                history: [
                  {
                    kind: "message",
                    messageId: "snapshot-1",
                    role: "agent",
                    parts: [{ kind: "text", text: "Snapshot hello" }],
                  },
                ],
                artifacts: [],
              },
            }),
          );
          return;
        }

        if (body.method === "message/stream" || body.method === "tasks/resubscribe") {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            Connection: "keep-alive",
            "Cache-Control": "no-cache",
          });

          const sendEvent = (payload: unknown) => {
            res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: rpcId, result: payload })}\n\n`);
          };

          sendEvent({
            kind: "task",
            id: "task-e2e",
            contextId: "ctx-e2e",
            status: { state: "working" },
            history: [],
            artifacts: [],
          });

          if (body.params?.taskId === "artifact-append") {
            sendEvent({
              kind: "artifact-update",
              contextId: "ctx-e2e",
              taskId: "artifact-append",
              append: true,
              lastChunk: false,
              artifact: {
                artifactId: "artifact-append",
                parts: [{ kind: "text", text: "chunk-1" }],
              },
            });
            sendEvent({
              kind: "artifact-update",
              contextId: "ctx-e2e",
              taskId: "artifact-append",
              append: false,
              lastChunk: true,
              artifact: {
                artifactId: "artifact-append",
                parts: [{ kind: "text", text: "final" }],
              },
            });
            sendEvent({
              kind: "status-update",
              contextId: "ctx-e2e",
              taskId: "artifact-append",
              final: true,
              status: { state: "succeeded" as const, message: undefined, timestamp: new Date().toISOString() },
            });
            res.end();
            return;
          } else if (body.params?.taskId === "task-hitl-e2e") {
            sendEvent({
              kind: "status-update",
              contextId: "ctx-e2e",
              taskId: "task-hitl-e2e",
              final: false,
              status: {
                state: "input-required",
                message: {
                  kind: "message",
                  messageId: "status-hitl",
                  role: "agent",
                  parts: [
                    { kind: "text", text: "Need approval" },
                    { kind: "data", data: { type: "a2a.hitl.form", formId: "form-123" } },
                  ],
                },
              },
            });
            res.end();
            return;
          } else if (body.method === "tasks/resubscribe") {
            sendEvent({
              kind: "status-update",
              contextId: "ctx-e2e",
              taskId: "task-e2e",
              final: false,
              status: {
                state: "working",
                message: {
                  kind: "message",
                  messageId: "status-e2e",
                  role: "agent",
                  parts: [{ kind: "text", text: "Resubscribe status" }],
                },
                timestamp: new Date().toISOString(),
              },
            });
          } else {
            sendEvent({
              kind: "message",
              messageId: "stream-1",
              role: "agent",
              parts: [{ kind: "text", text: "Stream hello" }],
              contextId: "ctx-e2e",
              taskId: "task-e2e",
            });
          }

          sendEvent({
            kind: "artifact-update",
            contextId: "ctx-e2e",
            taskId: "task-e2e",
            append: false,
            lastChunk: true,
            artifact: {
              artifactId: "artifact-e2e",
              parts: [{ kind: "data", data: { foo: "bar" } }],
            },
          });

        sendEvent({
          kind: "status-update",
          contextId: "ctx-e2e",
          taskId: "task-e2e",
          final: true,
          status: {
            state: "succeeded",
            timestamp: new Date().toISOString(),
            message: {
              kind: "message",
              messageId: "status-final",
              role: "agent",
              parts: [{ kind: "text", text: "Completed" }],
            },
          },
        });

          res.end();
          return;
        }

        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: rpcId, error: { code: -32601, message: "Method not found" } }));
      });
      return;
    }

    res.writeHead(404);
    res.end();
  };

  server = http.createServer(handler);

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        }),
      ),
    getRpcCalls: () => [...rpcCalls],
    resetRpcCalls: () => {
      rpcCalls.length = 0;
    },
  };
};

describe("A2A live e2e (local test server)", () => {
  let server: TestServer | undefined;
  const observedEvents: BaseEvent[] = [];

  beforeAll(async () => {
    server = await startA2AServer();
  });

  beforeEach(() => {
    observedEvents.length = 0;
    server?.resetRpcCalls();
  });

  afterAll(async () => {
    if (server) {
      await server.close();
    }
  });

  it("runs end-to-end against the local A2A server", async () => {
    if (!server) {
      throw new Error("Test server failed to start");
    }

    const client = new A2AClient(server.baseUrl);
    const agent = new A2AAgent({
      a2aClient: client,
      initialMessages: [
        createMessage({ id: "user-live-1", role: "user", content: "Hello from AG-UI e2e" }),
      ],
      initialState: { view: { tasks: {}, artifacts: {} } },
    });

    const result = await agent.runAgent(
      {
        forwardedProps: { a2a: { mode: "stream" } },
      },
      {
        onEvent: ({ event }) => {
          observedEvents.push(event);
        },
      },
    );

    expect(result.newMessages.some((message) => message.role === "assistant")).toBe(true);

    const hasText =
      observedEvents.some(
        (event) =>
          (event.type === EventType.TEXT_MESSAGE_CONTENT ||
            event.type === EventType.TEXT_MESSAGE_CHUNK) &&
          "delta" in event &&
          typeof (event as { delta?: unknown }).delta === "string",
      ) ||
      result.newMessages.some((message) => typeof message.content === "string");
    expect(hasText).toBe(true);

    expect(
      (agent.state as { view?: { artifacts?: Record<string, unknown> } }).view?.artifacts?.[
        "artifact-e2e"
      ],
    ).toEqual({ foo: "bar" });
  });

  it("replays snapshots and continues streaming on resubscribe without reopening the run", async () => {
    if (!server) {
      throw new Error("Test server failed to start");
    }

    const client = new A2AClient(server.baseUrl);
    const agent = new A2AAgent({
      a2aClient: client,
      initialMessages: [],
      initialState: { view: { tasks: {}, artifacts: {} } },
    });

    const events: BaseEvent[] = [];

    const result = await agent.runAgent(
      {
        forwardedProps: {
          a2a: { mode: "stream", taskId: "task-e2e", subscribeOnly: true, historyLength: 2 },
        },
      },
      {
        onEvent: ({ event }) => {
          events.push(event);
        },
      },
    );

    const textChunks = events.filter(
      (event) =>
        event.type === EventType.TEXT_MESSAGE_CHUNK || event.type === EventType.TEXT_MESSAGE_CONTENT,
    );
    const stateDeltas = events.filter((event) => event.type === EventType.STATE_DELTA);

    expect(
      textChunks.some((event) => (event as { delta?: unknown }).delta === "Snapshot hello"),
    ).toBe(true);
    expect(
      textChunks.some((event) => (event as { delta?: unknown }).delta === "Resubscribe status"),
    ).toBe(true);
    expect(stateDeltas.length).toBeGreaterThanOrEqual(2);
    expect(
      (agent.state as { view?: { tasks?: Record<string, unknown>; artifacts?: Record<string, unknown> } })
        .view?.tasks?.["task-e2e"],
    ).toEqual(
      expect.objectContaining({
        status: expect.objectContaining({ state: expect.any(String) }),
      }),
    );
    expect(
      (agent.state as { view?: { artifacts?: Record<string, unknown> } }).view?.artifacts?.[
        "artifact-e2e"
      ],
    ).toEqual({ foo: "bar" });

    const combinedAssistantText = result.newMessages
      .filter((message) => message.role === "assistant")
      .map((message) => String(message.content ?? ""))
      .join(" ");

    expect(combinedAssistantText).toContain("Snapshot");
    expect(combinedAssistantText).toContain("Resubscribe");
  });

  it("routes Engram config updates via send without leaking thread/run identifiers", async () => {
    if (!server) {
      throw new Error("Test server failed to start");
    }

    const client = new A2AClient(server.baseUrl);
    const agent = new A2AAgent({
      a2aClient: client,
      initialMessages: [createMessage({ id: "user-1", role: "user", content: "update config" })],
    });

    await agent.runAgent({
      forwardedProps: {
        a2a: { mode: "send", engramUpdate: { scope: "task", update: { feature: true } } },
      },
      runId: "run-hidden",
    });

    const rpcCalls = server.getRpcCalls();
    const sendCall = rpcCalls.find((call) => call.method === "message/send");
    const headers = sendCall?.headers ?? {};
    const metadata = (sendCall?.body as { params?: { metadata?: Record<string, unknown> } } | undefined)
      ?.params?.metadata as Record<string, unknown> | undefined;

    expect(headers["x-a2a-extensions"]).toContain(ENGRAM_EXTENSION_URI);
    expect(metadata?.engram).toEqual(expect.objectContaining({ scope: "task", update: { feature: true } }));
    expect(metadata).not.toHaveProperty("threadId");
    expect(metadata).not.toHaveProperty("runId");
  });

  it("projects artifact append then snapshot into shared state under canonical paths", async () => {
    if (!server) {
      throw new Error("Test server failed to start");
    }

    const client = new A2AClient(server.baseUrl);
    const agent = new A2AAgent({
      a2aClient: client,
      initialMessages: [createMessage({ id: "user-artifacts", role: "user", content: "stream artifacts" })],
      initialState: { view: { tasks: {}, artifacts: {} } },
    });

    const events: BaseEvent[] = [];

    await agent.runAgent(
      {
        forwardedProps: { a2a: { mode: "stream", taskId: "artifact-append", contextId: "ctx-e2e" } },
      },
      { onEvent: ({ event }) => events.push(event) },
    );

    const rpcCalls = server.getRpcCalls();
    expect(
      rpcCalls.some((call) => call.method === "message/stream" || call.method === "tasks/resubscribe"),
    ).toBe(true);

    const artifactPatches =
      events
        .filter((event) => event.type === EventType.STATE_DELTA)
        .flatMap(
          (event) =>
            ((event as { delta?: Array<{ path?: string; value?: unknown }> }).delta ?? []).filter(
              (patch) => patch.path === "/view/artifacts/artifact-append",
            ),
        ) ?? [];
    expect(artifactPatches.some((patch) => patch.value === "final")).toBe(true);
  });

  it("emits interrupt outcome and pending interrupts on HITL input_required", async () => {
    if (!server) {
      throw new Error("Test server failed to start");
    }

    const client = new A2AClient(server.baseUrl);
    const agent = new A2AAgent({
      a2aClient: client,
      initialMessages: [createMessage({ id: "user-hitl", role: "user", content: "hitl" })],
      initialState: { view: { tasks: {}, artifacts: {}, pendingInterrupts: {} } },
    });

    const events: BaseEvent[] = [];

    await agent.runAgent(
      {
        forwardedProps: { a2a: { mode: "stream", taskId: "task-hitl-e2e", contextId: "ctx-e2e" } },
      },
      { onEvent: ({ event }) => events.push(event) },
    );

    const rpcCalls = server.getRpcCalls();
    expect(
      rpcCalls.some((call) => call.method === "message/stream" || call.method === "tasks/resubscribe"),
    ).toBe(true);

    const runFinished = events.find((event) => event.type === EventType.RUN_FINISHED) as
      | { result?: Record<string, unknown> }
      | undefined;
    expect(runFinished?.result).toEqual(
      expect.objectContaining({ outcome: "interrupt", taskId: "task-hitl-e2e", contextId: "ctx-e2e" }),
    );
    expect(
      (agent.state as { view?: { pendingInterrupts?: Record<string, unknown> } }).view?.pendingInterrupts,
    ).not.toEqual({});
  });

  it("resumes a HITL interrupt via formResponse and completes the task", async () => {
    if (!server) {
      throw new Error("Test server failed to start");
    }

    const client = new A2AClient(server.baseUrl);
    const agent = new A2AAgent({
      a2aClient: client,
      initialMessages: [createMessage({ id: "user-hitl-1", role: "user", content: "start hitl" })],
      initialState: { view: { tasks: {}, artifacts: {}, pendingInterrupts: {} } },
    });

    const interruptEvents: BaseEvent[] = [];
    await agent.runAgent(
      {
        forwardedProps: { a2a: { mode: "stream", taskId: "task-hitl-e2e", contextId: "ctx-e2e" } },
        runId: "run-hitl-1",
      },
      { onEvent: ({ event }) => interruptEvents.push(event) },
    );

    const runFinished = interruptEvents.find((event) => event.type === EventType.RUN_FINISHED) as
      | { result?: Record<string, unknown> }
      | undefined;
    const interruptId = (runFinished?.result as { interruptId?: string } | undefined)?.interruptId;
    expect(interruptId).toBeDefined();

    server.resetRpcCalls();
    const resumeEvents: BaseEvent[] = [];
    await agent.runAgent(
      {
        forwardedProps: {
          a2a: {
            mode: "send",
            taskId: "task-hitl-e2e",
            contextId: "ctx-e2e",
            resume: { interruptId: interruptId ?? "", payload: { approved: true } },
          },
        },
        runId: "run-hitl-2",
      },
      { onEvent: ({ event }) => resumeEvents.push(event) },
    );

    const sendCall = server.getRpcCalls().find((call) => call.method === "message/send");
    const messageParts =
      ((sendCall?.body as { params?: { message?: { parts?: unknown[] } } } | undefined)?.params?.message
        ?.parts as Array<{ data?: { type?: string; values?: Record<string, unknown> } }> | undefined) ?? [];
    expect(
      messageParts.some(
        (part) =>
          part.data?.type === "a2a.hitl.formResponse" &&
          (part.data.values as Record<string, unknown> | undefined)?.approved === true,
      ),
    ).toBe(true);
    expect(
      ((sendCall?.body as { params?: { message?: { taskId?: string; contextId?: string } } } | undefined)?.params
        ?.message?.taskId),
    ).toBe("task-hitl-e2e");
    expect(
      ((sendCall?.body as { params?: { message?: { taskId?: string; contextId?: string } } } | undefined)?.params
        ?.message?.contextId),
    ).toBe("ctx-e2e");

    const stateDeltas = resumeEvents.filter((event) => event.type === EventType.STATE_DELTA);
    expect(
      stateDeltas.some((event) =>
        (event as { delta?: Array<{ path?: string; value?: unknown }> }).delta?.some(
          (patch) => patch.path === "/view/tasks/task-hitl-e2e/status" && (patch.value as { state?: string })?.state === "succeeded",
        ),
      ),
    ).toBe(true);
  });
});

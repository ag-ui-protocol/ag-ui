import http from "http";
import express from "express";
import { A2AAgent } from "../agent";
import { A2AClient } from "@a2a-js/sdk/client";
import type { AddressInfo } from "net";
import type { BaseEvent, Message } from "@ag-ui/client";
import { EventType } from "@ag-ui/client";
import {
  DefaultRequestHandler,
  InMemoryTaskStore,
  DefaultExecutionEventBusManager,
  A2AExpressApp,
  type AgentExecutor,
} from "@a2a-js/sdk/server";
import { randomUUID } from "crypto";
import { ENGRAM_EXTENSION_URI } from "../utils";

const createMessage = (message: Partial<Message>): Message => message as Message;

jest.setTimeout(30000);

type TestServer = {
  baseUrl: string;
  close: () => Promise<void>;
  getRpcCalls: () => Array<{ method: string; body: unknown; headers: http.IncomingHttpHeaders }>;
  resetRpcCalls: () => Promise<void>;
};

class ResettableTaskStore extends InMemoryTaskStore {
  clear() {
    // @ts-expect-error store is defined on the base class
    this.store.clear();
  }
}

type ExecutionEvent = Parameters<
  ReturnType<DefaultExecutionEventBusManager["createOrGetByTaskId"]>["publish"]
>[0];

const createAgentExecutor = (
  taskStore: ResettableTaskStore,
  eventBusManager: DefaultExecutionEventBusManager,
): AgentExecutor => {
  return {
    // eventBus is supplied but intentionally unused; the shared eventBusManager per taskId is used instead.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async execute(requestContext, _eventBus?: unknown) {
      const taskId = requestContext.task?.id ?? requestContext.taskId ?? requestContext.userMessage.taskId ?? "task-e2e";
      const contextId = requestContext.userMessage.contextId ?? "ctx-e2e";
      // Always publish through the shared event bus manager so resubscribes see the same stream.
      const taskBus = eventBusManager.createOrGetByTaskId(taskId);
      const baseMessage = {
        ...requestContext.userMessage,
        taskId,
        contextId,
      };

      const existingTask =
        (await taskStore.load(taskId)) ?? {
          kind: "task" as const,
          id: taskId,
          contextId,
          status: { state: "working" as const, timestamp: new Date().toISOString() },
          history: [],
          artifacts: [],
        };
      const history = [...(existingTask.history ?? [])];
      history.push({
        ...baseMessage,
        taskId,
        contextId,
      });
      await taskStore.save({ ...existingTask, contextId, history });

      const publish = (event: ExecutionEvent) => taskBus.publish(event);

      const hasResumeResponse =
        Array.isArray(baseMessage.parts) &&
        baseMessage.parts.some((part: { data?: { type?: string } }) => part.data?.type === "a2a.input.response");

      if (taskId === "artifact-append") {
        publish({
          kind: "task",
          id: taskId,
          contextId,
          status: { state: "working" as const, timestamp: new Date().toISOString() },
          history: [],
          artifacts: [],
        });
        publish({
          kind: "artifact-update",
          contextId,
          taskId,
          append: true,
          lastChunk: false,
          artifact: {
            artifactId: "artifact-append",
            parts: [{ kind: "text", text: "chunk-1" }],
          },
        });
        publish({
          kind: "artifact-update",
          contextId,
          taskId,
          append: false,
          lastChunk: true,
          artifact: {
            artifactId: "artifact-append",
            parts: [{ kind: "text", text: "final" }],
          },
        });
        publish({
          kind: "status-update",
          contextId,
          taskId,
          final: true,
          status: {
            state: "succeeded" as const,
            timestamp: new Date().toISOString(),
          },
        });
        await taskStore.save({
          ...existingTask,
          contextId,
          history,
          artifacts: [
            {
              artifactId: "artifact-e2e",
              parts: [{ kind: "data", data: { foo: "bar" } }, { kind: "text", text: "final" }],
            },
          ],
          status: { state: "succeeded" as const, timestamp: new Date().toISOString() },
        });
        taskBus.finished();
        return;
      }

      if (taskId === "task-input-e2e") {
        if (hasResumeResponse) {
          publish({
            kind: "task",
            id: taskId,
            contextId,
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
            history,
            artifacts: existingTask.artifacts ?? [],
          });
          publish({
            kind: "status-update",
            contextId,
            taskId,
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
          });
          await taskStore.save({
            ...existingTask,
            contextId,
            history,
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
          });
        } else {
          publish({
            kind: "status-update",
            contextId,
            taskId,
            final: false,
            status: {
              state: "input-required",
              message: {
                kind: "message",
                messageId: "status-input",
                role: "agent",
                parts: [
                  { kind: "text", text: "Need approval" },
                  { kind: "data", data: { type: "a2a.input.request", requestId: "request-123" } },
                ],
              },
              timestamp: new Date().toISOString(),
            },
          });
          await taskStore.save({
            ...existingTask,
            contextId,
            history,
            status: {
              state: "input-required" as const,
              message: {
                kind: "message",
                messageId: "status-input",
                role: "agent",
                parts: [
                  { kind: "text", text: "Need approval" },
                  { kind: "data", data: { type: "a2a.input.request", requestId: "request-123" } },
                ],
              },
              timestamp: new Date().toISOString(),
            },
          });
        }
        taskBus.finished();
        return;
      }

      const responseText =
        typeof (baseMessage as { parts?: Array<{ kind?: string; text?: string }> }).parts?.[0]?.text === "string"
          ? (baseMessage as { parts?: Array<{ kind?: string; text?: string }> }).parts?.[0]?.text ?? "Hello"
          : "Hello stream";
      const assistantMessageId = baseMessage.messageId ? `${baseMessage.messageId}-resp` : randomUUID();

      publish({
        kind: "task",
        id: taskId,
        contextId,
        status: { state: "working" as const, timestamp: new Date().toISOString() },
        history: [],
        artifacts: [],
      });

      publish({
        kind: "artifact-update",
        contextId,
        taskId,
        append: false,
        lastChunk: true,
        artifact: {
          artifactId: "artifact-e2e",
          parts: [{ kind: "data", data: { foo: "bar" } }],
        },
      });

      publish({
        kind: "status-update",
        contextId,
        taskId,
        final: true,
        status: {
          state: "succeeded" as const,
          message: {
            kind: "message",
            messageId: "status-final",
            role: "agent",
            parts: [{ kind: "text", text: "Completed" }],
          },
          timestamp: new Date().toISOString(),
        },
      });

      await taskStore.save({
        ...existingTask,
        contextId,
        history,
        artifacts: [
          ...(existingTask.artifacts ?? []),
          {
            artifactId: "artifact-e2e",
            parts: [{ kind: "data", data: { foo: "bar" } }, { kind: "text", text: "final" }],
          },
        ],
        status: {
          state: "succeeded" as const,
          timestamp: new Date().toISOString(),
        },
      });

      publish({
        kind: "message",
        messageId: assistantMessageId,
        role: "agent",
        parts: [{ kind: "text", text: `Echo: ${responseText}` }],
        contextId,
        taskId,
      });

      taskBus.finished();
    },
    async cancelTask(taskId, eventBus) {
      const taskBus = eventBus ?? eventBusManager.createOrGetByTaskId(taskId);
      taskBus.publish({
        kind: "status-update",
        contextId: "ctx-e2e",
        taskId,
        final: true,
        status: { state: "canceled" as const, timestamp: new Date().toISOString() },
      });
      taskBus.finished();
    },
  };
};

const startA2AServer = async (): Promise<TestServer> => {
  const rpcCalls: Array<{ method: string; body: unknown; headers: http.IncomingHttpHeaders }> = [];
  const app = express();
  const taskStore = new ResettableTaskStore();
  const eventBusManager = new DefaultExecutionEventBusManager();
  const agentExecutor = createAgentExecutor(taskStore, eventBusManager);
  const agentCard: ConstructorParameters<typeof DefaultRequestHandler>[0] = {
    url: "/a2a",
    capabilities: { streaming: true },
    name: "local-e2e-agent",
    description: "Local A2A test server",
  };
  const requestHandler = new DefaultRequestHandler(agentCard, taskStore, agentExecutor, eventBusManager);
  const handlerWithResubscribe = requestHandler as DefaultRequestHandler & {
    resubscribe?: (params: { id: string }) => AsyncGenerator<unknown>;
  };
  handlerWithResubscribe.resubscribe = async function* (
    params: { id: string },
  ) {
    const task = await taskStore.load(params.id);
    if (task) {
      yield task;
      yield {
        kind: "status-update",
        contextId: task.contextId,
        taskId: task.id,
        final: false,
        status: {
          state: "working" as const,
          message: {
            kind: "message" as const,
            messageId: "status-e2e",
            role: "agent" as const,
            parts: [{ kind: "text" as const, text: "Resubscribe status" }],
          },
          timestamp: new Date().toISOString(),
        },
      };
    }
  };
  const a2aApp = new A2AExpressApp(requestHandler);
  app.use(express.json());
  app.use((req, _res, next) => {
    if (req.method === "POST") {
      rpcCalls.push({
        method: (req.body as { method?: string })?.method ?? "",
        body: req.body,
        headers: req.headers,
      });
    }
    next();
  });
  const baseRouter = a2aApp.setupRoutes(app, "/a2a");

  const server = http.createServer(baseRouter);

  const seedState = async () => {
    taskStore.clear();
    const baseTask = (
      id: string,
      history: Array<Record<string, unknown>> = [],
      artifacts: Array<Record<string, unknown>> = [],
    ) => ({
      kind: "task" as const,
      id,
      contextId: "ctx-e2e",
      status: { state: "working" as const, timestamp: new Date().toISOString() },
      history,
      artifacts,
    });

    await taskStore.save(
      baseTask(
        "task-e2e",
        [
          {
            kind: "message" as const,
            messageId: "snapshot-1",
            role: "agent" as const,
            parts: [{ kind: "text" as const, text: "Snapshot hello" }],
            contextId: "ctx-e2e",
            taskId: "task-e2e",
          },
        ],
        [
          {
            artifactId: "artifact-e2e",
            parts: [{ kind: "data", data: { foo: "bar" } }],
          },
        ],
      ),
    );
    await taskStore.save(
      baseTask("artifact-append", [], [
        {
          artifactId: "artifact-e2e",
          parts: [{ kind: "data", data: { foo: "bar" } }],
        },
      ]),
    );
    await taskStore.save(baseTask("task-input-e2e"));

    const resubscribeBus = eventBusManager.createOrGetByTaskId("task-e2e");
    resubscribeBus.publish({
      kind: "status-update",
      contextId: "ctx-e2e",
      taskId: "task-e2e",
      final: false,
      status: {
        state: "working" as const,
        message: {
          kind: "message" as const,
          messageId: "status-e2e",
          role: "agent" as const,
          parts: [{ kind: "text" as const, text: "Resubscribe status" }],
        },
        timestamp: new Date().toISOString(),
      },
    });
    resubscribeBus.finished();
    rpcCalls.length = 0;
  };

  await seedState();

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}/a2a`;
  agentCard.url = baseUrl;
  if ((requestHandler as { agentCard?: { url?: string } }).agentCard) {
    (requestHandler as { agentCard?: { url?: string } }).agentCard!.url = baseUrl;
  }

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
    resetRpcCalls: () => seedState(),
  };
};

describe("A2A live e2e (local test server)", () => {
  let server: TestServer | undefined;
  const observedEvents: BaseEvent[] = [];

  beforeAll(async () => {
    server = await startA2AServer();
  });

  beforeEach(async () => {
    observedEvents.length = 0;
    if (server) {
      await server.resetRpcCalls();
    }
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

    const artifactDeltas =
      observedEvents
        .filter((event) => event.type === EventType.STATE_DELTA)
        .flatMap(
          (event) =>
            ((event as { delta?: Array<{ path?: string; value?: unknown }> }).delta ?? []).filter(
              (patch) => patch.path === "/view/artifacts/artifact-e2e",
            ),
        ) ?? [];
    expect(artifactDeltas.length).toBeGreaterThan(0);
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
      stateDeltas.some((event) =>
        (event as { delta?: Array<{ path?: string }> }).delta?.some(
          (patch) => patch.path === "/view/artifacts/artifact-e2e",
        ),
      ),
    ).toBe(true);

    const combinedAssistantText = result.newMessages
      .filter((message) => message.role === "assistant")
      .map((message) => String(message.content ?? ""))
      .join(" ");

    expect(combinedAssistantText).toContain("Snapshot");
    expect(combinedAssistantText).toContain("Resubscribe");
  });

  it("binds threadId to server contextId and defers events until bound", async () => {
    if (!server) {
      throw new Error("Test server failed to start");
    }

    const client = new A2AClient(server.baseUrl);
    const agent = new A2AAgent({
      a2aClient: client,
      initialMessages: [createMessage({ id: "user-bind-1", role: "user", content: "bind thread" })],
      initialState: { view: { tasks: {}, artifacts: {} } },
    });

    const events: BaseEvent[] = [];

    // Given a fresh run with no contextId provided
    const result = await agent.runAgent(
      {
        forwardedProps: { a2a: { mode: "stream" } },
      },
      {
        onEvent: ({ event }) => {
          events.push(event);
        },
      },
    );

    const rpcCalls = server.getRpcCalls();
    const streamCall = rpcCalls.find((call) => call.method === "message/stream");
    const params = (streamCall?.body as { params?: { message?: Record<string, unknown>; metadata?: Record<string, unknown> } } | undefined)
      ?.params;

    // Then outbound stream omits contextId so the server can assign it
    expect(params?.message?.contextId).toBeUndefined();
    expect(params?.metadata?.contextId).toBeUndefined();

    // Then RUN_STARTED is emitted once with threadId bound to server contextId before downstream events
    const runStartedIndex = events.findIndex((event) => event.type === EventType.RUN_STARTED);
    expect(runStartedIndex).toBe(0);
    const runStarted = events[runStartedIndex] as { threadId?: string };
    const boundContextId =
      (agent.state as { view?: { tasks?: Record<string, { contextId?: string }> } }).view?.tasks
        ?.[Object.keys((agent.state as { view?: { tasks?: Record<string, unknown> } }).view?.tasks ?? {})[0]]
        ?.contextId;
    expect(runStarted.threadId).toBe(boundContextId);
    expect(events.slice(runStartedIndex + 1)[0]?.type).toBe(EventType.STATE_SNAPSHOT);

    // And the finishing event also carries the bound threadId/contextId
    const runFinished = events.find((event) => event.type === EventType.RUN_FINISHED) as
      | { threadId?: string }
      | undefined;
    expect(runFinished?.threadId).toBe(boundContextId);

    // And assistant output was produced
    expect(result.newMessages.some((message) => message.role === "assistant")).toBe(true);
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

  it("emits interrupt outcome and pending interrupts on input_required", async () => {
    if (!server) {
      throw new Error("Test server failed to start");
    }

    const client = new A2AClient(server.baseUrl);
    const agent = new A2AAgent({
      a2aClient: client,
      initialMessages: [createMessage({ id: "user-input", role: "user", content: "input" })],
      initialState: { view: { tasks: {}, artifacts: {}, pendingInterrupts: {} } },
    });

    const events: BaseEvent[] = [];

    await agent.runAgent(
      {
        forwardedProps: { a2a: { mode: "stream", taskId: "task-input-e2e", contextId: "ctx-e2e" } },
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
      expect.objectContaining({ outcome: "interrupt", taskId: "task-input-e2e", contextId: "ctx-e2e" }),
    );
    expect(
      (agent.state as { view?: { pendingInterrupts?: Record<string, unknown> } }).view?.pendingInterrupts,
    ).not.toEqual({});
  });

  it("resumes an input interrupt via response and completes the task", async () => {
    if (!server) {
      throw new Error("Test server failed to start");
    }

    const client = new A2AClient(server.baseUrl);
    const agent = new A2AAgent({
      a2aClient: client,
      debug: true,
      initialMessages: [createMessage({ id: "user-input-1", role: "user", content: "start input" })],
      initialState: { view: { tasks: {}, artifacts: {}, pendingInterrupts: {} } },
    });

    const interruptEvents: BaseEvent[] = [];
    await agent.runAgent(
      {
        forwardedProps: { a2a: { mode: "stream", taskId: "task-input-e2e", contextId: "ctx-e2e" } },
        runId: "run-input-1",
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
            taskId: "task-input-e2e",
            contextId: "ctx-e2e",
            resume: { interruptId: interruptId ?? "", payload: { approved: true } },
          },
        },
        runId: "run-input-2",
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
          part.data?.type === "a2a.input.response" &&
          (part.data.values as Record<string, unknown> | undefined)?.approved === true,
      ),
    ).toBe(true);
    expect(
      ((sendCall?.body as { params?: { message?: { taskId?: string; contextId?: string } } } | undefined)?.params
        ?.message?.taskId),
    ).toBe("task-input-e2e");
    expect(
      ((sendCall?.body as { params?: { message?: { taskId?: string; contextId?: string } } } | undefined)?.params
        ?.message?.contextId),
    ).toBe("ctx-e2e");

    const stateDeltas = resumeEvents.filter((event) => event.type === EventType.STATE_DELTA);
    const succeededFromDelta = stateDeltas.some((event) =>
      (event as { delta?: Array<{ path?: string; value?: unknown }> }).delta?.some(
        (patch) =>
          patch.path === "/view/tasks/task-input-e2e/status" &&
          (patch.value as { state?: string })?.state === "succeeded",
      ),
    );
    type ResumeSnapshot = {
      snapshot?: { view?: { tasks?: Record<string, { status?: { state?: string } }> } };
    };
    const snapshotState =
      (resumeEvents.find((event) => event.type === EventType.STATE_SNAPSHOT) as ResumeSnapshot | undefined)?.snapshot
        ?.view?.tasks?.["task-input-e2e"]?.status?.state;
    expect(succeededFromDelta || snapshotState === "succeeded").toBe(true);
  });
});

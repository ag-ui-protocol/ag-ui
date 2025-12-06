import http from "http";
import express from "express";
import type { AddressInfo } from "net";
import { A2AAgent } from "../agent";
import { A2AClient } from "@a2a-js/sdk/client";
import {
  A2AExpressApp,
  DefaultExecutionEventBusManager,
  DefaultRequestHandler,
  InMemoryTaskStore,
  type AgentExecutor,
} from "@a2a-js/sdk/server";
import { ENGRAM_EXTENSION_URI } from "../utils";
import { EventType } from "@ag-ui/client";
import type { BaseEvent } from "@ag-ui/client";
import type { EngramEvent, EngramRecord } from "../types";
import { applyPatch } from "fast-json-patch";

type RpcCall = { method: string; body: unknown; headers: http.IncomingHttpHeaders };

type EngramStoreEntry = EngramRecord & { key: { key: string } };

type EngramTestServer = {
  baseUrl: string;
  close: () => Promise<void>;
  getRpcCalls: () => RpcCall[];
  reset: (seed?: Partial<EngramStoreEntry>) => void;
};

const createEngramEvents = (record: EngramStoreEntry): EngramEvent[] => {
  const snapshot: EngramEvent = {
    kind: "snapshot",
    key: record.key,
    record,
    version: record.version,
    sequence: "1",
    updatedAt: record.updatedAt,
  };

  const delta: EngramEvent = {
    kind: "delta",
    key: record.key,
    patch: [{ op: "add", path: "/synced", value: true }],
    version: record.version + 1,
    sequence: "2",
    updatedAt: new Date().toISOString(),
  };

  return [snapshot, delta];
};

const toArtifact = (engramEvent: EngramEvent, taskId: string, contextId: string) => ({
  kind: "artifact-update" as const,
  contextId,
  taskId,
  append: false,
  lastChunk: true,
  artifact: {
    artifactId: "engram-stream",
    parts: [
      {
        kind: "data" as const,
        data: {
          type: "engram/event",
          event: engramEvent,
        },
      },
    ],
  },
});

const requireEngramHeader = (headers: http.IncomingHttpHeaders) => {
  const value = headers["x-a2a-extensions"];
  if (!value || !String(value).includes(ENGRAM_EXTENSION_URI)) {
    const error = new Error("Missing Engram extension header");
    (error as { code?: number }).code = -400;
    throw error;
  }
};

class ResettableTaskStore extends InMemoryTaskStore {
  clear() {
    // @ts-expect-error store is defined on the base class
    this.store.clear();
  }
}

const createAgentExecutor = (
  taskStore: ResettableTaskStore,
  eventBusManager: DefaultExecutionEventBusManager,
): AgentExecutor => {
  return {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async execute(requestContext, _eventBus) {
      const taskId =
        requestContext.task?.id ??
        requestContext.taskId ??
        requestContext.userMessage.taskId ??
        "task-engram";
      const contextId = requestContext.userMessage.contextId ?? "ctx-engram";

      const existingTask =
        (await taskStore.load(taskId)) ?? {
          kind: "task" as const,
          id: taskId,
          contextId,
          status: { state: "working" as const, timestamp: new Date().toISOString() },
          history: [],
          artifacts: [],
        };

      await taskStore.save({
        ...existingTask,
        history: [...(existingTask.history ?? []), requestContext.userMessage],
      });

      const bus = eventBusManager.createOrGetByTaskId(taskId);
      bus.publish({
        kind: "status-update",
        contextId,
        taskId,
        final: true,
        status: { state: "succeeded" as const, timestamp: new Date().toISOString() },
      });
      bus.finished();
    },
    async cancelTask(taskId, eventBus) {
      const bus = eventBus ?? eventBusManager.createOrGetByTaskId(taskId);
      bus.finished();
    },
  };
};

const startEngramServer = async (): Promise<EngramTestServer> => {
  const rpcCalls: RpcCall[] = [];
  const app = express();
  app.use(express.json());

  const store = new Map<string, EngramStoreEntry>();
  const streams = new Map<string, { contextId: string; events: EngramEvent[] }>();

  const taskStore = new ResettableTaskStore();
  const eventBusManager = new DefaultExecutionEventBusManager();
  const agentExecutor = createAgentExecutor(taskStore, eventBusManager);
  const agentCard: ConstructorParameters<typeof DefaultRequestHandler>[0] = {
    url: "/a2a",
    capabilities: { streaming: true, extensions: [ENGRAM_EXTENSION_URI] },
    name: "local-engram-agent",
    description: "Local Engram test server",
  };
  const requestHandler = new DefaultRequestHandler(agentCard, taskStore, agentExecutor, eventBusManager);
  const handlerWithResubscribe = requestHandler as DefaultRequestHandler & {
    resubscribe?: (params: { id: string }) => AsyncGenerator<unknown>;
  };
  const originalResubscribe = requestHandler.resubscribe.bind(requestHandler);

  const seedStore = (seed?: Partial<EngramStoreEntry>) => {
    rpcCalls.length = 0;
    store.clear();
    taskStore.clear();
    const now = new Date().toISOString();
    const record: EngramStoreEntry = {
      key: { key: seed?.key?.key ?? "config.workflow" },
      value: seed?.value ?? { enabled: true },
      version: seed?.version ?? 1,
      createdAt: seed?.createdAt ?? now,
      updatedAt: seed?.updatedAt ?? now,
      tags: seed?.tags,
      labels: seed?.labels,
    };
    store.set(record.key.key, record);
    streams.set("engram-task", { contextId: "ctx-engram", events: createEngramEvents(record) });
    void taskStore.save({
      kind: "task" as const,
      id: "engram-task",
      contextId: "ctx-engram",
      status: { state: "working" as const, timestamp: now },
      history: [],
      artifacts: [],
    });
  };

  seedStore();

  handlerWithResubscribe.resubscribe = async function* (params: { id: string }) {
    if (streams.has(params.id)) {
      const stream = streams.get(params.id)!;
      for (const event of stream.events) {
        yield toArtifact(event, params.id, stream.contextId);
      }
      return;
    }

    yield* originalResubscribe(params);
  };

  app.use((req, _res, next) => {
    if (req.method === "POST" && req.path.startsWith("/a2a")) {
      const method = ((req.body ?? {}) as { method?: string }).method ?? "";
      rpcCalls.push({ method, body: req.body, headers: req.headers });
    }
    next();
  });

  app.post("/a2a", async (req, res, next) => {
    const { id = 1, method = "", params = {} } = (req.body ?? {}) as {
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
    };

    if (!String(method).startsWith("engram/")) {
      return next();
    }

    const respond = (payload: unknown) => res.json({ jsonrpc: "2.0", id, result: payload });
    const respondError = (message: string, code = -32000) =>
      res.status(400).json({ jsonrpc: "2.0", id, error: { code, message } });

    try {
      requireEngramHeader(req.headers);
    } catch (error) {
      return respondError((error as Error).message, (error as { code?: number }).code ?? -400);
    }

    const filter = (params as { filter?: { keyPrefix?: string } }).filter;
    const filteredRecords = Array.from(store.values()).filter((record) =>
      filter?.keyPrefix ? record.key.key.startsWith(filter.keyPrefix) : true,
    );

    if (method === "engram/subscribe") {
      const taskId = (params as { taskId?: string }).taskId ?? "engram-task";
      const contextId = (params as { contextId?: string }).contextId ?? "ctx-engram";
      const record = filteredRecords[0] ?? Array.from(store.values())[0];
      const events = createEngramEvents(
        record ?? {
          key: { key: "config.workflow" },
          value: { enabled: true },
          version: 1,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      );
      streams.set(taskId, { contextId, events });
      await taskStore.save({
        kind: "task" as const,
        id: taskId,
        contextId,
        status: { state: "working" as const, timestamp: new Date().toISOString() },
        history: [],
        artifacts: [],
      });
      return respond({ taskId });
    }

    if (method === "engram/list") {
      return respond({ records: filteredRecords });
    }

    if (method === "engram/set") {
      const key = (params as { key?: { key?: string } }).key?.key;
      const value = (params as { value?: unknown }).value;
      if (!key) {
        return respondError("Missing key", -409);
      }
      const expectedVersion = (params as { expectedVersion?: number }).expectedVersion;
      const existing = store.get(key);
      if (typeof expectedVersion === "number" && expectedVersion !== (existing?.version ?? 0)) {
        return respondError("Version mismatch", -409);
      }
      const now = new Date().toISOString();
      const nextVersion = (existing?.version ?? 0) + 1;
      const record: EngramStoreEntry = {
        key: { key },
        value,
        version: nextVersion,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        tags: (params as { tags?: string[] }).tags ?? existing?.tags,
        labels: (params as { labels?: Record<string, string> }).labels ?? existing?.labels,
      };
      store.set(key, record);
      streams.set("engram-task", { contextId: "ctx-engram", events: createEngramEvents(record) });
      return respond({ record });
    }

    if (method === "engram/patch") {
      const key = (params as { key?: { key?: string } }).key?.key;
      const patch = (params as { patch?: unknown[] }).patch ?? [];
      const expectedVersion = (params as { expectedVersion?: number }).expectedVersion;
      const existing = key ? store.get(key) : undefined;
      if (!key || !existing) {
        return respondError("Record not found", -409);
      }
      if (typeof expectedVersion === "number" && expectedVersion !== existing.version) {
        return respondError("Version mismatch", -409);
      }
      const now = new Date().toISOString();
      const value = applyPatch(structuredClone(existing.value), patch, false, false).newDocument;
      const record: EngramStoreEntry = { ...existing, value, version: existing.version + 1, updatedAt: now };
      store.set(key, record);
      streams.set("engram-task", { contextId: "ctx-engram", events: createEngramEvents(record) });
      return respond({ record });
    }

    if (method === "engram/delete") {
      const key = (params as { key?: { key?: string } }).key?.key;
      const existing = key ? store.get(key) : undefined;
      if (!key || !existing) {
        return respondError("Record not found", -409);
      }
      store.delete(key);
      return respond({ deleted: true, previousVersion: existing.version });
    }

    return respondError(`Unhandled method ${method}`, -32004);
  });

  const a2aApp = new A2AExpressApp(requestHandler);
  const baseRouter = a2aApp.setupRoutes(app, "/a2a");
  const server = http.createServer(baseRouter);

  const seed = (seed?: Partial<EngramStoreEntry>) => seedStore(seed);

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}/a2a`;
  agentCard.url = baseUrl;
  if ((requestHandler as { agentCard?: { url?: string } }).agentCard) {
    (requestHandler as { agentCard?: { url?: string } }).agentCard!.url = baseUrl;
  }

  return {
    baseUrl,
    getRpcCalls: () => [...rpcCalls],
    reset: seed,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        }),
      ),
  };
};

describe("A2A Engram happy-path e2e (local server)", () => {
  let server: EngramTestServer | undefined;
  let consoleWarnSpy: jest.SpyInstance | undefined;

  beforeAll(async () => {
    server = await startEngramServer();
  });

  beforeEach(() => {
    consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    server?.reset();
    consoleWarnSpy?.mockRestore();
  });

  afterAll(async () => {
    if (server) {
      await server.close();
    }
  });

  it("hydrates via hydrate_stream and emits snapshot then delta", async () => {
    if (!server) {
      throw new Error("Test server failed to start");
    }

    const client = new A2AClient(server.baseUrl);
    const agent = new A2AAgent({ a2aClient: client, engram: { enabled: true }, initialMessages: [] });
    const events: BaseEvent[] = [];

    await agent.runAgent(
      {
        messages: [],
        state: {},
        forwardedProps: { engram: { mode: "hydrate_stream", filter: { keyPrefix: "config" } } },
      },
      { onEvent: ({ event }) => events.push(event) },
    );

    const snapshot = events.find((event) => event.type === EventType.STATE_SNAPSHOT) as
      | { snapshot?: Record<string, unknown> }
      | undefined;
    const delta = events.find((event) => event.type === EventType.STATE_DELTA) as
      | { delta?: Array<{ path?: string }> }
      | undefined;

    expect(snapshot?.snapshot).toBeDefined();
    expect(
      (snapshot?.snapshot as { view?: { engram?: Record<string, unknown> } })?.view?.engram?.["config.workflow"],
    ).toBeDefined();
    expect(delta?.delta?.some((patch) => (patch.path ?? "").includes("/view/engram/"))).toBe(true);

    const headerCall = server.getRpcCalls().find((call) => call.method === "engram/subscribe");
    expect(headerCall?.headers["x-a2a-extensions"]).toContain(ENGRAM_EXTENSION_URI);
  });

  it("hydrates once and finishes after a single snapshot", async () => {
    if (!server) {
      throw new Error("Test server failed to start");
    }

    const client = new A2AClient(server.baseUrl);
    const agent = new A2AAgent({ a2aClient: client, engram: { enabled: true }, initialMessages: [] });
    const events: BaseEvent[] = [];

    await agent.runAgent(
      {
        messages: [],
        state: {},
        forwardedProps: { engram: { mode: "hydrate_once", filter: { keyPrefix: "config" } } },
      },
      { onEvent: ({ event }) => events.push(event) },
    );

    const snapshots = events.filter((event) => event.type === EventType.STATE_SNAPSHOT);
    expect(snapshots).toHaveLength(1);
    expect(events.some((event) => event.type === EventType.RUN_FINISHED)).toBe(true);
  });

  it("syncs UI state to Engram and returns reconciled snapshot", async () => {
    if (!server) {
      throw new Error("Test server failed to start");
    }

    const client = new A2AClient(server.baseUrl);
    const agent = new A2AAgent({ a2aClient: client, engram: { enabled: true }, initialMessages: [] });

    agent.state = { view: { engram: { "config.workflow": { value: { enabled: false }, version: 1 } } } };

    const events: BaseEvent[] = [];
    await agent.runAgent(
      {
        messages: [],
        forwardedProps: { engram: { mode: "sync", filter: { keyPrefix: "config" } } },
      },
      { onEvent: ({ event }) => events.push(event) },
    );

    const snapshot = events.find((event) => event.type === EventType.STATE_SNAPSHOT) as
      | { snapshot?: Record<string, unknown> }
      | undefined;
    expect(
      (snapshot?.snapshot as { view?: { engram?: Record<string, { value?: { enabled?: boolean } }> } })
        ?.view?.engram?.["config.workflow"]?.value,
    ).toEqual(expect.objectContaining({ enabled: false }));

    expect(server.getRpcCalls().some((call) => call.method === "engram/set")).toBe(true);
  });

  it("resumes Engram stream with monotonic sequences", async () => {
    if (!server) {
      throw new Error("Test server failed to start");
    }

    const client = new A2AClient(server.baseUrl);
    const agent = new A2AAgent({ a2aClient: client, engram: { enabled: true }, initialMessages: [] });

    const sequences: string[] = [];

    for await (const event of agent.streamEngram({ filter: { keyPrefix: "config" }, engram: true })) {
      const seq = (event as { rawEvent?: { sequence?: string } }).rawEvent?.sequence;
      if (seq) {
        sequences.push(seq);
      }
      if (sequences.length >= 1) {
        break; // simulate dropped stream after first event
      }
    }

    const lastSequence = sequences[sequences.length - 1];

    for await (const event of agent.streamEngram({
      taskId: "engram-task",
      engram: true,
      fromSequence: lastSequence,
    })) {
      const seq = (event as { rawEvent?: { sequence?: string } }).rawEvent?.sequence;
      if (seq) {
        sequences.push(seq);
      }
    }

    expect(new Set(sequences)).toEqual(new Set(["1", "2"]));
    expect(sequences[0]).toBe("1");
    expect(sequences[sequences.length - 1]).toBe("2");
  });
});

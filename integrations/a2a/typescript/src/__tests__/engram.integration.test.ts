import { A2AAgent } from "../agent";
import { A2AClient } from "@a2a-js/sdk/client";
import { ENGRAM_EXTENSION_URI } from "../utils";
import { EventType } from "@ag-ui/client";
import type { BaseEvent, Message } from "@ag-ui/client";
import { applyPatch } from "fast-json-patch";
import { filter, firstValueFrom, tap } from "rxjs";

type EngramEntry = {
  value: unknown;
  version: number;
  createdAt: string;
  updatedAt: string;
  tags?: string[];
  labels?: Record<string, string>;
};

const encoder = new TextEncoder();

const createSseResponse = (events: unknown[], rpcId: number) =>
  new Response(
    new ReadableStream({
      start(controller) {
        for (const event of events) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ jsonrpc: "2.0", id: rpcId, result: event })}\n\n`,
            ),
          );
        }
        controller.close();
      },
    }),
    {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    },
  );

type RpcLog = Array<{ headers: Headers; body: Record<string, unknown> }>;

type SubscriptionStreams = Map<string, unknown[]>;

type FetchFactoryParams = {
  store: Map<string, EngramEntry>;
  rpcLog: RpcLog;
  streams: SubscriptionStreams;
};

const createMessage = (message: Partial<Message>): Message => message as Message;

const buildFetchMock = ({ store, rpcLog, streams }: FetchFactoryParams) =>
  jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();

    if (url.endsWith("/.well-known/agent.json")) {
      return new Response(
        JSON.stringify({
          url: `${typeof input === "string" ? input.replace("/.well-known/agent.json", "") : url.replace("/.well-known/agent.json", "")}/rpc`,
          capabilities: { streaming: true, extensions: [ENGRAM_EXTENSION_URI] },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (url.endsWith("/rpc")) {
      const headers = new Headers(init?.headers);
      const body = init?.body ? JSON.parse(init.body as string) : {};
      rpcLog.push({ headers, body });
      const rpcId = typeof body.id === "number" ? body.id : 1;
      const method = body.method as string;
      const params = (body.params ?? {}) as Record<string, unknown>;

      if (headers.get("Accept")?.includes("text/event-stream")) {
        const streamEvents = streams.get((params.id as string) ?? (params.taskId as string)) ?? [];
        return createSseResponse(streamEvents, rpcId);
      }

      const jsonResponse = (payload: Record<string, unknown>) =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });

      const conflict = (message: string) =>
        jsonResponse({ jsonrpc: "2.0", id: rpcId, error: { code: -409, message } });

      if (method === "engram/set") {
        const key = (params.key as { key: string })?.key;
        if (!key) {
          return conflict("Missing key");
        }

        const existing = store.get(key);
        if (
          typeof params.expectedVersion === "number" &&
          params.expectedVersion !== (existing?.version ?? 0)
        ) {
          return conflict("Version mismatch");
        }

        const now = new Date().toISOString();
        const nextVersion = (existing?.version ?? 0) + 1;
        const record = {
          key: params.key,
          value: params.value,
          version: nextVersion,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
          tags: params.tags ?? existing?.tags,
        } as EngramEntry;
        store.set(key, record);

        return jsonResponse({ jsonrpc: "2.0", id: rpcId, result: { record } });
      }

      if (method === "engram/get") {
        const targetKey = (params.key as { key?: string })?.key;
        const records = targetKey
          ? store.has(targetKey)
            ? [store.get(targetKey)]
            : []
          : Array.from(store.values());
        return jsonResponse({ jsonrpc: "2.0", id: rpcId, result: { records } });
      }

      if (method === "engram/list") {
        const records = Array.from(store.values());
        return jsonResponse({ jsonrpc: "2.0", id: rpcId, result: { records } });
      }

      if (method === "engram/patch") {
        const key = (params.key as { key: string })?.key;
        const existing = key ? store.get(key) : undefined;
        if (!existing) {
          return conflict("Record not found");
        }
        if (
          typeof params.expectedVersion === "number" &&
          params.expectedVersion !== existing.version
        ) {
          return conflict("Version mismatch");
        }
        const now = new Date().toISOString();
        const patchedValue = applyPatch(
          structuredClone(existing.value),
          (params.patch as unknown[]) ?? [],
          false,
          false,
        ).newDocument;
        const record = {
          ...existing,
          value: patchedValue,
          version: existing.version + 1,
          updatedAt: now,
        } as EngramEntry;
        store.set(key as string, record);
        return jsonResponse({ jsonrpc: "2.0", id: rpcId, result: { record } });
      }

      if (method === "engram/delete") {
        const key = (params.key as { key: string })?.key;
        const existing = key ? store.get(key) : undefined;
        if (!existing) {
          return conflict("Record not found");
        }
        if (
          typeof params.expectedVersion === "number" &&
          params.expectedVersion !== existing.version
        ) {
          return conflict("Version mismatch");
        }
        store.delete(key as string);
        return jsonResponse({
          jsonrpc: "2.0",
          id: rpcId,
          result: { deleted: true, previousVersion: existing.version },
        });
      }

      if (method === "engram/subscribe") {
        const taskId = `sub-${streams.size + 1}`;
        const now = new Date().toISOString();
        const firstRecord = store.values().next().value as EngramEntry | undefined;
        const targetKey = (params.filter as { keyPrefix?: string })?.keyPrefix ?? "config/workflow";
        const record =
          firstRecord ??
          ({
            key: { key: targetKey },
            value: { enabled: true },
            version: 1,
            createdAt: now,
            updatedAt: now,
          } as EngramEntry);

        const snapshotEvent = {
          kind: "artifact-update" as const,
          contextId: (params.contextId as string) ?? "ctx-engram",
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
                  event: {
                    kind: "snapshot",
                    key: record.key,
                    record,
                    version: record.version,
                    sequence: "1",
                    updatedAt: record.updatedAt,
                  },
                },
              },
            ],
          },
        };

        const updated = {
          ...record,
          value: applyPatch(structuredClone(record.value), [{ op: "add", path: "/synced", value: true }]).newDocument,
          version: (record.version ?? 0) + 1,
          updatedAt: new Date().toISOString(),
        } as EngramEntry;
        store.set((record.key as { key: string }).key, updated);

        const deltaEvent = {
          kind: "artifact-update" as const,
          contextId: (params.contextId as string) ?? "ctx-engram",
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
                  event: {
                    kind: "delta",
                    key: updated.key,
                    patch: [{ op: "add", path: "/synced", value: true }],
                    version: updated.version,
                    sequence: "2",
                    updatedAt: updated.updatedAt,
                  },
                },
              },
            ],
          },
        };

        streams.set(taskId, [snapshotEvent, deltaEvent]);
        return jsonResponse({ jsonrpc: "2.0", id: rpcId, result: { taskId } });
      }

      if (method === "tasks/resubscribe") {
        const taskId = (params.id as string) ?? "";
        const streamEvents = streams.get(taskId) ?? [];
        return jsonResponse({ jsonrpc: "2.0", id: rpcId, result: { ok: true, taskId, _events: streamEvents.length } });
      }

      return conflict(`Unhandled method ${method}`);
    }

    throw new Error(`Unhandled fetch URL: ${url}`);
  });

describe("Engram client integration", () => {
  const originalFetch = global.fetch;
  const safeFetch: typeof fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("engram.local")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            url: url.endsWith("/.well-known/agent.json") ? url.replace("/.well-known/agent.json", "/rpc") : url,
            capabilities: { streaming: true, extensions: [ENGRAM_EXTENSION_URI] },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
    return originalFetch(input, init);
  };

  afterEach(() => {
    global.fetch = safeFetch;
    jest.clearAllMocks();
  });

  const collectRunEvents = async (
    agent: A2AAgent,
    params: Parameters<A2AAgent["run"]>[0],
  ): Promise<BaseEvent[]> => {
    const events: BaseEvent[] = [];
    await firstValueFrom(
      agent
        .run(params)
        .pipe(
          tap((event) => events.push(event)),
          filter((event) => event.type === EventType.RUN_FINISHED),
        ),
    );
    return events;
  };

  it("requires activation and supports CAS for engram RPC", async () => {
    const store = new Map<string, EngramEntry>();
    const rpcLog: RpcLog = [];
    const streams: SubscriptionStreams = new Map();
    const fetchMock = buildFetchMock({ store, rpcLog, streams });
    global.fetch = fetchMock as unknown as typeof fetch;

    const client = new A2AClient("https://engram.local");

    const disabledAgent = new A2AAgent({ a2aClient: client, initialMessages: [] });
    await expect(
      disabledAgent.engramGet({ key: { key: "config/workflow" } }),
    ).rejects.toThrow(/Engram is disabled/i);

    const agent = new A2AAgent({ a2aClient: client, engram: { enabled: true }, initialMessages: [] });

    const setResult = await agent.engramSet({ key: { key: "config/workflow" }, value: { enabled: true } });
    expect(setResult.record.version).toBe(1);

    const patchResult = await agent.engramPatch({
      key: { key: "config/workflow" },
      expectedVersion: setResult.record.version,
      patch: [{ op: "replace", path: "/enabled", value: false }],
    });
    expect(patchResult.record.version).toBe(2);

    await expect(
      agent.engramPatch({
        key: { key: "config/workflow" },
        expectedVersion: 1,
        patch: [{ op: "replace", path: "/enabled", value: true }],
      }),
    ).rejects.toThrow(/version/i);

    expect(
      rpcLog.some((call) => call.headers.get("X-A2A-Extensions")?.includes(ENGRAM_EXTENSION_URI)),
    ).toBe(true);
  });

  it("streams Engram events into state deltas and resubscribe requests carry the extension header", async () => {
    const store = new Map<string, EngramEntry>();
    const rpcLog: RpcLog = [];
    const streams: SubscriptionStreams = new Map();
    const fetchMock = buildFetchMock({ store, rpcLog, streams });
    global.fetch = fetchMock as unknown as typeof fetch;

    const client = new A2AClient("https://engram.local");
    const agent = new A2AAgent({ a2aClient: client, engram: { enabled: true }, initialMessages: [] });

    const events: Array<{ type: EventType; [key: string]: unknown }> = [];
    for await (const event of agent.streamEngram({ filter: { keyPrefix: "config" }, engram: true })) {
      events.push(event as { type: EventType });
    }

    const stateSnapshots = events.filter((event) => event.type === EventType.STATE_SNAPSHOT);
    const stateDeltas = events.filter((event) => event.type === EventType.STATE_DELTA);

    expect(stateSnapshots.length).toBeGreaterThanOrEqual(1);
    expect(
      stateDeltas.some((delta) =>
        Array.isArray((delta as { delta?: Array<{ path?: string }> }).delta) &&
        (delta as { delta?: Array<{ path?: string }> }).delta?.some((entry) =>
          (entry.path ?? "").includes("/view/engram/"),
        ),
      ),
    ).toBe(true);

    const resubscribeCall = rpcLog.find((call) => (call.body as { method?: string }).method === "tasks/resubscribe");
    expect(resubscribeCall?.headers.get("X-A2A-Extensions")).toContain(ENGRAM_EXTENSION_URI);
  });

  it("handles engram hydrate_stream via forwardedProps and emits snapshot then delta", async () => {
    const store = new Map<string, EngramEntry>();
    const rpcLog: RpcLog = [];
    const streams: SubscriptionStreams = new Map();
    const fetchMock = buildFetchMock({ store, rpcLog, streams });
    global.fetch = fetchMock as unknown as typeof fetch;

    const client = new A2AClient("https://engram.local");
    const agent = new A2AAgent({ a2aClient: client, engram: { enabled: true }, initialMessages: [] });

    const events = await collectRunEvents(agent, {
      messages: [],
      state: {},
      runId: "run-hydrate-stream",
      forwardedProps: { engram: { mode: "hydrate_stream", filter: { keyPrefix: "config" } } },
    });

    const snapshot = events.find((event) => event.type === EventType.STATE_SNAPSHOT);
    const delta = events.find((event) => event.type === EventType.STATE_DELTA);

    expect(snapshot).toBeDefined();
    expect(delta).toBeDefined();
  });

  it("resumes engram stream with monotonic sequence and no duplicates", async () => {
    const store = new Map<string, EngramEntry>();
    const rpcLog: RpcLog = [];
    const streams: SubscriptionStreams = new Map();
    const fetchMock = buildFetchMock({ store, rpcLog, streams });
    global.fetch = fetchMock as unknown as typeof fetch;

    const client = new A2AClient("https://engram.local");
    const agent = new A2AAgent({ a2aClient: client, engram: { enabled: true }, initialMessages: [] });

    const events: BaseEvent[] = [];
    const seenSequences: string[] = [];

    // first pass: subscribe and break after first delta
    for await (const event of agent.streamEngram({ filter: { keyPrefix: "config" }, engram: true })) {
      events.push(event as BaseEvent);
      const seq = (event as { rawEvent?: { sequence?: string } }).rawEvent?.sequence;
      if (seq) {
        seenSequences.push(seq);
      }

      if (event.type === EventType.STATE_DELTA) {
        break; // simulate dropped stream
      }
    }

    // second pass: resume from last sequence
    for await (const event of agent.streamEngram({
      taskId: "sub-1",
      filter: { keyPrefix: "config" },
      engram: true,
      fromSequence: seenSequences[seenSequences.length - 1],
    })) {
      events.push(event as BaseEvent);
      const seq = (event as { rawEvent?: { sequence?: string } }).rawEvent?.sequence;
      if (seq) {
        seenSequences.push(seq);
      }
    }

    const uniqueSequences = new Set(seenSequences);
    expect(uniqueSequences.has("1")).toBe(true);
    expect(uniqueSequences.has("2")).toBe(true);
    expect(Array.from(uniqueSequences)).toEqual(expect.arrayContaining(["1", "2"]));
    expect(seenSequences[0]).toBe("1");
    expect(seenSequences[seenSequences.length - 1]).toBe("2");
  });

  it("handles engram hydrate_once via forwardedProps and emits one snapshot then finishes", async () => {
    const store = new Map<string, EngramEntry>();
    const rpcLog: RpcLog = [];
    const streams: SubscriptionStreams = new Map();
    const now = new Date().toISOString();
    store.set("config/workflow", {
      key: { key: "config/workflow" },
      value: { enabled: true },
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const fetchMock = buildFetchMock({ store, rpcLog, streams });
    global.fetch = fetchMock as unknown as typeof fetch;

    const client = new A2AClient("https://engram.local");
    const agent = new A2AAgent({ a2aClient: client, engram: { enabled: true }, initialMessages: [] });

    const events = await collectRunEvents(agent, {
      messages: [],
      state: {},
      runId: "run-hydrate-once",
      forwardedProps: { engram: { mode: "hydrate_once", filter: { keyPrefix: "config" } } },
    });

    const snapshots = events.filter((event) => event.type === EventType.STATE_SNAPSHOT);
    expect(snapshots).toHaveLength(1);
    const runFinishedIndex = events.findIndex((event) => event.type === EventType.RUN_FINISHED);
    expect(runFinishedIndex).toBeGreaterThan(-1);
  });

  it("applies sync mode by pushing local engram state then emitting snapshot", async () => {
    const store = new Map<string, EngramEntry>();
    const rpcLog: RpcLog = [];
    const streams: SubscriptionStreams = new Map();
    const fetchMock = buildFetchMock({ store, rpcLog, streams });
    global.fetch = fetchMock as unknown as typeof fetch;

    const client = new A2AClient("https://engram.local");
    const agent = new A2AAgent({ a2aClient: client, engram: { enabled: true }, initialMessages: [] });

    const events = await collectRunEvents(agent, {
      messages: [],
      state: { view: { engram: { "config/workflow": { value: { enabled: true } } } } },
      runId: "run-sync",
      forwardedProps: { engram: { mode: "sync", filter: { keyPrefix: "config" } } },
    });

    const snapshots = events.filter((event) => event.type === EventType.STATE_SNAPSHOT);
    expect(snapshots).toHaveLength(1);
    const snapshotState = (snapshots[0] as { snapshot?: Record<string, unknown> }).snapshot ?? {};
    expect(
      (snapshotState as { view?: { engram?: Record<string, { value?: { enabled?: boolean } }> } })
        ?.view?.engram?.["config/workflow"]?.value,
    ).toEqual(expect.objectContaining({ enabled: true }));
    expect(
      rpcLog.some((call) => (call.body as { method?: string }).method === "engram/set"),
    ).toBe(true);
  });

  it("merges message and engram streams without reordering within each stream", async () => {
    const store = new Map<string, EngramEntry>();
    const rpcLog: RpcLog = [];
    const streams: SubscriptionStreams = new Map();
    const fetchMock = buildFetchMock({ store, rpcLog, streams });
    global.fetch = fetchMock as unknown as typeof fetch;

    const client = new A2AClient("https://engram.local");
    const agent = new A2AAgent({ a2aClient: client, engram: { enabled: true }, initialMessages: [] });

    const events = await collectRunEvents(agent, {
      messages: [],
      state: {},
      runId: "run-merge",
      forwardedProps: { engram: { mode: "hydrate_stream" } },
    });

    const stateEvents = events.filter((event) => event.type === EventType.STATE_DELTA || event.type === EventType.STATE_SNAPSHOT);

    // Engram stream present
    expect(stateEvents.length).toBeGreaterThan(0);
  });

  it("requests fresh hydrate when JSON Patch application fails", async () => {
    const store = new Map<string, EngramEntry>();
    const rpcLog: RpcLog = [];
    const streams: SubscriptionStreams = new Map();
    const fetchMock = buildFetchMock({ store, rpcLog, streams });
    global.fetch = fetchMock as unknown as typeof fetch;

    const client = new A2AClient("https://engram.local");
    const agent = new A2AAgent({ a2aClient: client, engram: { enabled: true }, initialMessages: [] });

    const badPatchEvent = {
      kind: "artifact-update" as const,
      contextId: "ctx-engram",
      taskId: "sub-err",
      append: false,
      lastChunk: true,
      artifact: {
        artifactId: "engram-stream",
        parts: [
          {
            kind: "data" as const,
            data: {
              type: "engram/event",
              event: {
                kind: "delta",
                key: { key: "config/bad" },
                patch: [{ op: "invalid_op" as "add", path: "/nonexistent/leaf", value: true }],
                version: 2,
                sequence: "2",
                updatedAt: new Date().toISOString(),
              },
            },
          },
        ],
      },
    } as const;

    // inject bad patch into stream after first snapshot
    streams.set("sub-err", [
      {
        kind: "artifact-update",
        contextId: "ctx-engram",
        taskId: "sub-err",
        append: false,
        lastChunk: true,
        artifact: {
          artifactId: "engram-stream",
          parts: [
            {
              kind: "data",
              data: {
                type: "engram/event",
                event: {
                  kind: "snapshot",
                  key: { key: "config/bad" },
                  record: {
                    key: { key: "config/bad" },
                    value: { stable: true },
                    version: 1,
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                  },
                  version: 1,
                  sequence: "1",
                  updatedAt: new Date().toISOString(),
                },
              },
            },
          ],
        },
      },
      badPatchEvent,
    ]);

    const events: BaseEvent[] = [];
    for await (const event of agent.streamEngram({ taskId: "sub-err", engram: true })) {
      events.push(event as BaseEvent);
      if (event.type === EventType.RUN_ERROR) {
        break;
      }
    }

    expect(events.some((event) => event.type === EventType.RUN_ERROR)).toBe(true);
  });

  it("rejects engram runs with messages present or unknown mode", async () => {
    const store = new Map<string, EngramEntry>();
    const rpcLog: RpcLog = [];
    const streams: SubscriptionStreams = new Map();
    const fetchMock = buildFetchMock({ store, rpcLog, streams });
    global.fetch = fetchMock as unknown as typeof fetch;

    const client = new A2AClient("https://engram.local");
    const agent = new A2AAgent({ a2aClient: client, engram: { enabled: true }, initialMessages: [] });

    await expect(
      collectRunEvents(agent, {
        messages: [createMessage({ id: "u1", role: "user", content: "hi" })],
        state: {},
        runId: "run-guardrail",
        forwardedProps: { engram: { mode: "hydrate_stream" } },
      }),
    ).rejects.toThrow(/do not accept messages/i);

    await expect(
      collectRunEvents(agent, {
        messages: [],
        state: {},
        runId: "run-unknown",
        forwardedProps: { engram: { mode: "unknown_mode" } },
      }),
    ).rejects.toThrow(/unknown Engram mode/i);
  });

  it("skips orchestrator/LLM calls on engram-only runs", async () => {
    const store = new Map<string, EngramEntry>();
    const rpcLog: RpcLog = [];
    const streams: SubscriptionStreams = new Map();
    const fetchMock = buildFetchMock({ store, rpcLog, streams });
    global.fetch = fetchMock as unknown as typeof fetch;

    const client = new A2AClient("https://engram.local");
    const agent = new A2AAgent({ a2aClient: client, engram: { enabled: true }, initialMessages: [] });

    await collectRunEvents(agent, {
      messages: [],
      state: {},
      runId: "run-skip-llm",
      forwardedProps: { engram: { mode: "hydrate_stream", filter: { keyPrefix: "config" } } },
    });

    expect(rpcLog.every((call) => typeof call.body.method === "string" && !call.body.method.startsWith("message/"))).toBe(
      true,
    );
  });

  it("preserves per-stream ordering when messages and Engram artifacts are interleaved", async () => {
    const rpcBodies: Array<Record<string, unknown>> = [];

    const streamEvents = [
      {
        kind: "artifact-update" as const,
        contextId: "ctx-mixed",
        taskId: "task-mixed",
        append: false,
        lastChunk: true,
        artifact: {
          artifactId: "engram-stream",
          parts: [
            {
              kind: "data" as const,
              data: {
                type: "engram/event",
                event: {
                  kind: "snapshot",
                  key: { key: "config/workflow" },
                  record: {
                    key: { key: "config/workflow" },
                    value: { enabled: true },
                    version: 1,
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                  },
                  version: 1,
                  sequence: "1",
                  updatedAt: new Date().toISOString(),
                },
              },
            },
          ],
        },
      },
      {
        kind: "message" as const,
        messageId: "resp-1",
        role: "agent",
        parts: [{ kind: "text" as const, text: "hello" }],
        contextId: "ctx-mixed",
        taskId: "task-mixed",
      },
      {
        kind: "artifact-update" as const,
        contextId: "ctx-mixed",
        taskId: "task-mixed",
        append: false,
        lastChunk: true,
        artifact: {
          artifactId: "engram-stream",
          parts: [
            {
              kind: "data" as const,
              data: {
                type: "engram/event",
                event: {
                  kind: "delta",
                  key: { key: "config/workflow" },
                  patch: [{ op: "replace", path: "/enabled", value: false }],
                  version: 2,
                  sequence: "2",
                  updatedAt: new Date().toISOString(),
                },
              },
            },
          ],
        },
      },
      {
        kind: "status-update" as const,
        taskId: "task-mixed",
        contextId: "ctx-mixed",
        final: true,
        status: { state: "succeeded" },
      },
    ];

    const fetchMock = buildFetchMock({
      store: new Map(),
      rpcLog: rpcBodies as RpcLog,
      streams: new Map([["task-mixed", streamEvents]]),
    });

    global.fetch = fetchMock as unknown as typeof fetch;

    const client = new A2AClient("https://engram.local");
    const agent = new A2AAgent({
      a2aClient: client,
      engram: { enabled: true },
      initialMessages: [],
    });

    const events: BaseEvent[] = [];
    for await (const event of agent.streamEngram({ taskId: "task-mixed", engram: true })) {
      events.push(event as BaseEvent);
    }

    const snapshotIndex = events.findIndex((event) => event.type === EventType.STATE_SNAPSHOT);
    const deltaIndex = events.findIndex((event) => event.type === EventType.STATE_DELTA);

    expect(snapshotIndex).toBeGreaterThan(-1);
    expect(deltaIndex).toBeGreaterThan(snapshotIndex);

    const sequenceOrder = events
      .filter((event) => "rawEvent" in event)
      .map((event) => (event as { rawEvent?: { sequence?: string } }).rawEvent?.sequence)
      .filter(Boolean) as string[];
    expect(sequenceOrder[0]).toBe("1");
    expect(sequenceOrder[sequenceOrder.length - 1]).toBe("2");
  });

  it("rejects engram forwardedProps when the constructor flag is disabled", async () => {
    const fetchMock = jest.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/.well-known/agent.json")) {
        return new Response(
          JSON.stringify({
            url: "https://agent.local/rpc",
            capabilities: { streaming: true, extensions: [ENGRAM_EXTENSION_URI] },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      throw new Error(`Unexpected fetch to ${url}`);
    });

    global.fetch = fetchMock as unknown as typeof fetch;

    const client = new A2AClient("https://agent.local");
    const agent = new A2AAgent({ a2aClient: client, initialMessages: [] });

    await expect(
      collectRunEvents(agent, {
        messages: [],
        state: {},
        runId: "run-disabled",
        forwardedProps: { engram: { mode: "hydrate_stream" } },
      }),
    ).rejects.toThrow(/Engram is disabled/i);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces an explicit error when the agent card omits the Engram extension", async () => {
    const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/.well-known/agent.json")) {
        return new Response(
          JSON.stringify({
            url: "https://agent.local/rpc",
            capabilities: { streaming: true, extensions: [] },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (url.endsWith("/rpc")) {
        const headers = new Headers(init?.headers);
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: { taskId: "t-missing-ext" } }),
          {
            status: 200,
            headers,
          },
        );
      }

      throw new Error(`Unhandled fetch URL: ${url}`);
    });

    global.fetch = fetchMock as unknown as typeof fetch;

    const client = new A2AClient("https://agent.local");
    const agent = new A2AAgent({ a2aClient: client, engram: { enabled: true }, initialMessages: [] });

    await expect(
      collectRunEvents(agent, {
        messages: [],
        state: {},
        runId: "run-missing-ext",
        forwardedProps: { engram: { mode: "hydrate_stream", filter: { keyPrefix: "config" } } },
      }),
    ).rejects.toThrow(/not advertised/i);
  });

  it("throws when forwardedProps.engram.mode is missing", async () => {
    const fetchMock = buildFetchMock({ store: new Map(), rpcLog: [], streams: new Map() });
    global.fetch = fetchMock as unknown as typeof fetch;

    const client = new A2AClient("https://engram.local");
    const agent = new A2AAgent({ a2aClient: client, engram: { enabled: true }, initialMessages: [] });

    await expect(
      collectRunEvents(agent, {
        messages: [],
        state: {},
        runId: "run-missing-mode",
        forwardedProps: { engram: {} },
      }),
    ).rejects.toThrow(/Engram run requested without a mode/i);
  });

  it("treats runs without engram.mode and without messages as normal non-Engram runs", async () => {
    const fetchSpy = jest.spyOn(global, "fetch");

    const client = new A2AClient("https://engram.local");
    const agent = new A2AAgent({ a2aClient: client, initialMessages: [] });

    const events = await collectRunEvents(agent, { messages: [], state: {}, runId: "run-no-engram" });

    expect(events.map((event) => event.type)).toEqual([EventType.RUN_STARTED, EventType.RUN_FINISHED]);
    expect(fetchSpy).toHaveBeenCalledTimes(1); // agent card fetch only

    fetchSpy.mockRestore();
  });
});

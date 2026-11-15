import { lastValueFrom, toArray } from "rxjs";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RunAgentInput } from "@ag-ui/client";
import { ManagedAgentsAgent } from "../agent";
import { InMemorySessionStore } from "../sessions";
import { createFakeClient } from "./fake-client";

const custom = (id: string) => ({
  type: "agent.custom_tool_use",
  id,
  name: "browser_tool",
  input: { id },
});
const approval = (id: string) => ({
  type: "agent.tool_use",
  id,
  name: "bash",
  input: { command: "echo ok" },
  evaluated_permission: "ask",
});
const idle = {
  type: "session.status_idle",
  id: "idle_end",
  stop_reason: { type: "end_turn" },
};
const parked = (ids: string[]) => ({
  type: "session.status_idle",
  id: "idle_pending",
  stop_reason: { type: "requires_action", event_ids: ids },
});
const input = (overrides: Partial<RunAgentInput> = {}): RunAgentInput => ({
  threadId: "imported",
  runId: "run",
  messages: [{ role: "user", id: "old", content: "already sent" }],
  tools: [],
  context: [],
  forwardedProps: {},
  ...overrides,
});
const collect = (agent: ManagedAgentsAgent, value = input()) =>
  lastValueFrom(agent.run(value).pipe(toArray()));
const agent = (
  fake: ReturnType<typeof createFakeClient>,
  store = new InMemorySessionStore(),
) =>
  new ManagedAgentsAgent({
    managedAgentId: "agent",
    environmentId: "env",
    client: fake.client,
    sessionStore: store,
    resolveSession: () => ({ sessionId: "original", lastUserMessageId: "old" }),
  });

describe("native session recovery", () => {
  it.each(["custom", "approval"])(
    "ignores late requires_action after a recovered %s answer",
    async (kind) => {
      const call = kind === "custom" ? custom("c1") : approval("c1");
      const fake = createFakeClient({
        histories: [[call]],
        streams: [
          [
            parked(["c1"]),
            {
              type: "agent.message",
              id: "reply",
              content: [{ type: "text", text: "continued" }],
            },
            idle,
          ],
        ],
      });
      const events = await collect(
        agent(fake),
        input(
          kind === "custom"
            ? {
                messages: [
                  {
                    role: "tool",
                    id: "result",
                    toolCallId: "c1",
                    content: "answer",
                  },
                ],
              }
            : {
                resume: [
                  { interruptId: "c1", status: "resolved", payload: "allow" },
                ],
              },
        ),
      );
      expect(fake.sent.flatMap((send) => send.events)).toHaveLength(1);
      expect(events.some((event) => event.type === "RUN_ERROR")).toBe(false);
      expect(events.at(-1)).toMatchObject({ type: "RUN_FINISHED" });
      expect(events.at(-1)).not.toHaveProperty("outcome");
    },
  );

  it("carries historical answer IDs into the live stream", async () => {
    const fake = createFakeClient({
      sessionStatus: "running",
      histories: [
        [
          custom("c1"),
          {
            type: "user.custom_tool_result",
            id: "result",
            custom_tool_use_id: "c1",
            content: [],
          },
        ],
      ],
      streams: [[parked(["c1"]), idle]],
    });
    const events = await collect(agent(fake));
    expect(events.some((event) => event.type === "RUN_ERROR")).toBe(false);
    expect(fake.sent).toEqual([]);
    expect(events.at(-1)).toMatchObject({ type: "RUN_FINISHED" });
  });

  it.each(["agent.tool_use", "agent.mcp_tool_use"])(
    "exposes a live %s approval without global idle and resumes after restart",
    async (type) => {
      const call = {
        ...approval("a1"),
        type,
        session_thread_id: "child",
        mcp_server_name: "server",
      };
      const store = new InMemorySessionStore();
      const first = createFakeClient({
        sessionStatus: "running",
        histories: [[]],
        streams: [[call, new Promise(() => {})]],
      });
      const subject = new ManagedAgentsAgent({
        managedAgentId: "agent",
        environmentId: "env",
        client: first.client,
        sessionStore: store,
        turnTimeoutMs: 100,
        resolveSession: () => ({
          sessionId: "original",
          lastUserMessageId: "old",
        }),
      });
      const events = await collect(subject);
      expect(events.at(-1)).toMatchObject({
        type: "RUN_FINISHED",
        outcome: {
          type: "interrupt",
          interrupts: [
            {
              id: "a1",
              toolCallId: "a1",
              metadata: { sessionId: "original", sessionThreadId: "child" },
            },
          ],
        },
      });
      const restored = new InMemorySessionStore();
      restored.set(
        "5:agent|0:|3:env|0:|imported",
        JSON.parse(JSON.stringify(store.get("5:agent|0:|3:env|0:|imported"))),
      );
      const second = createFakeClient({
        histories: [[call]],
        streams: [[parked(["a1"]), idle]],
      });
      const resumed = await collect(
        agent(second, restored),
        input({
          resume: [{ interruptId: "a1", status: "resolved", payload: "allow" }],
        }),
      );
      expect(second.sent.flatMap((send) => send.events)).toEqual([
        { type: "user.tool_confirmation", tool_use_id: "a1", result: "allow" },
      ]);
      expect(resumed.some((event) => event.type === "RUN_ERROR")).toBe(false);
      expect(resumed.at(-1)).not.toHaveProperty("outcome");
    },
  );

  it("does not duplicate saved tool arguments and completes partial text from history", async () => {
    const store = new InMemorySessionStore();
    store.set("5:agent|0:|3:env|0:|imported", {
      sessionId: "original",
      preserveTools: true,
      toolNames: [],
      pendingClientToolUseIds: [],
      lastUserMessageId: "old",
      lastEventId: "cursor",
    });
    const fake = createFakeClient({
      histories: [
        [
          { ...idle, id: "cursor" },
          custom("c1"),
          {
            type: "agent.message",
            id: "reply",
            content: [{ type: "text", text: "hello world" }],
          },
        ],
      ],
    });
    const events = await collect(
      agent(fake, store),
      input({
        messages: [
          {
            role: "assistant",
            id: "reply",
            content: "hello",
            toolCalls: [
              {
                id: "c1",
                type: "function",
                function: { name: "browser tool", arguments: '{"id":"c1"}' },
              },
            ],
          },
        ],
      }),
    );
    expect(events.filter((event) => event.type === "TOOL_CALL_ARGS")).toEqual(
      [],
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "TEXT_MESSAGE_CONTENT",
        delta: " world",
      }),
    );
  });

  it("restores the configured frontend name for a recovered custom call", async () => {
    const fake = createFakeClient({ histories: [[custom("c1")]] });
    const events = await collect(
      agent(fake),
      input({
        tools: [{ name: "browser tool", description: "", parameters: {} }],
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "TOOL_CALL_START",
        toolCallName: "browser tool",
      }),
    );
  });

  it("preserves unknown live tools and permissions arriving during reconnect", async () => {
    const fake = createFakeClient({
      sessionStatus: "running",
      histories: [[]],
      streams: [
        [
          custom("new_custom"),
          approval("new_approval"),
          parked(["new_custom", "new_approval"]),
        ],
      ],
    });
    const subject = new ManagedAgentsAgent({
      managedAgentId: "agent",
      environmentId: "env",
      client: fake.client,
      toolConfirmation: "deny",
      resolveSession: () => ({
        sessionId: "original",
        lastUserMessageId: "old",
      }),
    });
    const events = await collect(subject);
    expect(fake.sent).toEqual([]);
    expect(events.at(-1)).toMatchObject({
      type: "RUN_FINISHED",
      outcome: { interrupts: [{ id: "new_approval" }] },
    });
  });

  it("reopens without creating, replaying user text, replacing tools or rejecting pending calls", async () => {
    const fake = createFakeClient({
      histories: [[custom("c1"), approval("a1"), parked(["c1", "a1"])]],
    });
    const events = await collect(agent(fake));
    expect(fake.spies.create).not.toHaveBeenCalled();
    expect(fake.spies.update).not.toHaveBeenCalled();
    expect(fake.sent).toEqual([]);
    expect(fake.spies.stream.mock.invocationCallOrder[0]).toBeLessThan(
      fake.spies.list.mock.invocationCallOrder[0],
    );
    expect(events.at(-1)).toMatchObject({
      type: "RUN_FINISHED",
      outcome: {
        type: "interrupt",
        interrupts: [{ id: "a1", reason: "tool-approval" }],
      },
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        name: "managed_agents.session",
        value: { sessionId: "original", threadId: "imported" },
      }),
    );
  });

  it("recovers several requests after restart and sends only matching real answers", async () => {
    const store = new InMemorySessionStore();
    const history = [
      custom("c1"),
      custom("c2"),
      approval("a1"),
      parked(["c1", "c2", "a1"]),
    ];
    await collect(agent(createFakeClient({ histories: [history] }), store));
    // Serialized storage plus a new client/agent: no in-process pending callbacks survive.
    const snapshot = JSON.stringify(store.get("5:agent|0:|3:env|0:|imported"));
    const restored = new InMemorySessionStore();
    restored.set("5:agent|0:|3:env|0:|imported", JSON.parse(snapshot));
    const fake = createFakeClient({ histories: [history], streams: [[idle]] });
    await collect(
      agent(fake, restored),
      input({
        messages: [
          { role: "user", id: "old", content: "already sent" },
          {
            role: "tool",
            id: "r1",
            toolCallId: "c1",
            content: "actual first result",
          },
          {
            role: "tool",
            id: "r2",
            toolCallId: "c2",
            content: "actual second result",
          },
        ],
        resume: [{ interruptId: "a1", status: "resolved", payload: "allow" }],
      }),
    );
    expect(fake.sent).toEqual([
      {
        sessionId: "original",
        events: [
          {
            type: "user.tool_confirmation",
            tool_use_id: "a1",
            result: "allow",
          },
          {
            type: "user.custom_tool_result",
            custom_tool_use_id: "c1",
            content: [{ type: "text", text: "actual first result" }],
            is_error: false,
          },
          {
            type: "user.custom_tool_result",
            custom_tool_use_id: "c2",
            content: [{ type: "text", text: "actual second result" }],
            is_error: false,
          },
        ],
      },
    ]);
  });

  it("holds a new message while one request remains unanswered", async () => {
    const fake = createFakeClient({
      histories: [[custom("c1"), approval("a1"), parked(["c1", "a1"])]],
    });
    const events = await collect(
      agent(fake),
      input({
        messages: [
          { role: "user", id: "old", content: "old" },
          { role: "user", id: "new", content: "move on" },
          { role: "tool", id: "r1", toolCallId: "c1", content: "real" },
        ],
      }),
    );
    expect(fake.sent[0].events).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      outcome: { interrupts: [{ id: "a1" }] },
    });
  });

  it.each(["yes", {}, null])(
    "rejects malformed confirmation %j without sending",
    async (payload) => {
      const fake = createFakeClient({ histories: [[approval("a1")]] });
      const events = await collect(
        agent(fake),
        input({ resume: [{ interruptId: "a1", status: "resolved", payload }] }),
      );
      expect(events.at(-1)).toMatchObject({
        type: "RUN_ERROR",
        code: "invalid_resume",
      });
      expect(fake.sent).toEqual([]);
    },
  );

  it("denies only the explicitly cancelled pending permission", async () => {
    const fake = createFakeClient({
      histories: [[approval("a1"), approval("a2")]],
    });
    const events = await collect(
      agent(fake),
      input({ resume: [{ interruptId: "a1", status: "cancelled" }] }),
    );
    expect(fake.sent[0].events).toEqual([
      { type: "user.tool_confirmation", tool_use_id: "a1", result: "deny" },
    ]);
    expect(events.at(-1)).toMatchObject({
      outcome: { interrupts: [{ id: "a2" }] },
    });
  });

  it("does not recover already answered or duplicate cross-posted calls", async () => {
    const fake = createFakeClient({
      histories: [
        [
          custom("done"),
          custom("done"),
          {
            type: "user.custom_tool_result",
            id: "result",
            custom_tool_use_id: "done",
            content: [],
          },
          approval("a1"),
        ],
      ],
    });
    const events = await collect(agent(fake));
    expect(events.filter((e) => e.type === "TOOL_CALL_START")).toEqual([]);
    expect(fake.sent).toEqual([]);
  });

  it("deduplicates history overlap while streaming the resumed response", async () => {
    const history = [approval("a1"), parked(["a1"])];
    const fake = createFakeClient({
      histories: [history],
      streams: [
        [
          ...history,
          {
            type: "agent.message",
            id: "answer",
            content: [{ type: "text", text: "continued" }],
          },
          idle,
        ],
      ],
    });
    const events = await collect(
      agent(fake),
      input({
        resume: [{ interruptId: "a1", status: "resolved", payload: "allow" }],
      }),
    );
    expect(events.filter((e) => e.type === "TOOL_CALL_START")).toEqual([]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "TEXT_MESSAGE_CONTENT",
        messageId: "answer",
        delta: "continued",
      }),
    );
  });

  it("keeps terminated and inaccessible sessions bound without replacement", async () => {
    for (const options of [
      { sessionStatus: "terminated" },
      {
        sessionError: Object.assign(new Error("private details"), {
          status: 404,
        }),
      },
    ]) {
      const fake = createFakeClient(options);
      const subject = agent(fake);
      const first = await collect(subject);
      const second = await collect(subject);
      expect(first.at(-1)).toMatchObject({
        type: "RUN_ERROR",
        code: options.sessionStatus ? "session_ended" : "session_unavailable",
      });
      expect(second.at(-1)).toMatchObject({ type: "RUN_ERROR" });
      expect(fake.spies.create).not.toHaveBeenCalled();
      expect(fake.sent).toEqual([]);
    }
  });

  it("replays activity missed during a backend restart from a disk-persisted cursor without executing tools", async () => {
    const dir = await mkdtemp(join(tmpdir(), "managed-recovery-"));
    try {
      const key = "5:agent|0:|3:env|0:|imported";
      await writeFile(
        join(dir, "record.json"),
        JSON.stringify({
          sessionId: "original",
          preserveTools: true,
          toolNames: [],
          pendingClientToolUseIds: [],
          lastUserMessageId: "old",
          lastEventId: "before_restart",
        }),
      );
      const store = new InMemorySessionStore();
      store.set(
        key,
        JSON.parse(await readFile(join(dir, "record.json"), "utf8")),
      );
      const history = [
        { ...idle, id: "before_restart" },
        custom("offline_tool"),
        {
          type: "user.custom_tool_result",
          id: "offline_result",
          custom_tool_use_id: "offline_tool",
          content: [{ type: "text", text: "saved output" }],
        },
        {
          type: "agent.message",
          id: "offline_reply",
          content: [{ type: "text", text: "done while offline" }],
        },
        idle,
      ];
      const fake = createFakeClient({ histories: [history, history] });
      const events = await collect(agent(fake, store));
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "TEXT_MESSAGE_CONTENT",
          messageId: "offline_reply",
          delta: "done while offline",
        }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "TOOL_CALL_RESULT",
          messageId: "offline_result",
          toolCallId: "offline_tool",
          content: "saved output",
        }),
      );
      expect(fake.sent).toEqual([]);
      expect(store.get(key)?.lastEventId).toBe("idle_end");
      const next = await collect(agent(fake, store));
      expect(next.some((event) => event.type === "TEXT_MESSAGE_CONTENT")).toBe(
        false,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("preserves child identity and routes its pending result by the original call ID", async () => {
    const fake = createFakeClient({
      histories: [[{ ...custom("child_call"), session_thread_id: "child" }]],
      streams: [
        [
          {
            type: "session.thread_status_idle",
            id: "child_end",
            session_thread_id: "child",
            stop_reason: { type: "end_turn" },
          },
        ],
      ],
    });
    const subject = new ManagedAgentsAgent({
      managedAgentId: "agent",
      environmentId: "env",
      client: fake.client,
      resolveSession: () => ({
        sessionId: "original",
        sessionThreadId: "child",
        lastUserMessageId: "old",
      }),
    });
    const events = await collect(
      subject,
      input({
        messages: [
          {
            role: "tool",
            id: "r",
            toolCallId: "child_call",
            content: "actual",
          },
        ],
      }),
    );
    expect(fake.spies.list).toHaveBeenCalledWith(
      "child",
      { session_id: "original" },
      expect.any(Object),
    );
    expect(fake.sent[0]).toMatchObject({
      sessionId: "original",
      events: [{ custom_tool_use_id: "child_call" }],
    });
    expect(events.at(-1)).toMatchObject({ type: "RUN_FINISHED" });
  });

  it("fails clearly when a blocking request is missing from history", async () => {
    const fake = createFakeClient({ histories: [[parked(["missing"])]] });
    const events = await collect(agent(fake));
    expect(events.at(-1)).toMatchObject({
      type: "RUN_ERROR",
      code: "pending_request_unavailable",
    });
    expect(fake.sent).toEqual([]);
  });

  it("finishes when the session completed between retrieval and history enumeration", async () => {
    const fake = createFakeClient({
      sessionStatus: "running",
      histories: [[idle]],
    });
    const events = await collect(agent(fake));
    expect(events.at(-1)).toMatchObject({ type: "RUN_FINISHED" });
    expect(fake.sent).toEqual([]);
  });

  it("replays an owned session's response after a crash before its first received event", async () => {
    const store = new InMemorySessionStore();
    store.set("5:agent|0:|3:env|0:|imported", {
      sessionId: "original",
      toolNames: [],
      pendingClientToolUseIds: [],
      lastUserMessageId: "old",
    });
    const fake = createFakeClient({
      histories: [
        [
          {
            type: "agent.message",
            id: "missed",
            content: [{ type: "text", text: "completed" }],
          },
          idle,
        ],
      ],
    });
    const events = await collect(agent(fake, store));
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "TEXT_MESSAGE_CONTENT",
        messageId: "missed",
        delta: "completed",
      }),
    );
    expect(fake.sent).toEqual([]);
  });

  it("reports a child terminating after history enumeration as ended", async () => {
    const fake = createFakeClient({
      sessionStatus: "running",
      histories: [[]],
      streams: [
        [
          {
            type: "session.thread_status_terminated",
            id: "ended",
            session_thread_id: "child",
          },
        ],
      ],
    });
    const subject = new ManagedAgentsAgent({
      managedAgentId: "agent",
      environmentId: "env",
      client: fake.client,
      resolveSession: () => ({
        sessionId: "original",
        sessionThreadId: "child",
        lastUserMessageId: "old",
      }),
    });
    const events = await collect(subject);
    expect(events.at(-1)).toMatchObject({
      type: "RUN_ERROR",
      code: "session_ended",
    });
  });

  it("does not expose an approval already resolved externally before end_turn", async () => {
    const fake = createFakeClient({
      histories: [
        [
          approval("a1"),
          {
            type: "user.tool_confirmation",
            id: "external",
            tool_use_id: "a1",
            result: "allow",
          },
          idle,
        ],
      ],
    });
    const events = await collect(agent(fake));
    expect(events.at(-1)).toMatchObject({ type: "RUN_FINISHED" });
    expect(events.at(-1)).not.toHaveProperty("outcome");
  });
});

it.each([
  "agent.tool_result",
  "agent.mcp_tool_result",
  "user.custom_tool_result",
])(
  "replays rich %s with native identity and one original raw envelope",
  async (type) => {
    const content = [
      { type: "text", text: "  " + "x".repeat(30000) + "\n" },
      {
        type: "image",
        source: { type: "base64", data: "AAEC", media_type: "image/png" },
      },
    ];
    const field =
      type === "agent.tool_result"
        ? "tool_use_id"
        : type === "agent.mcp_tool_result"
          ? "mcp_tool_use_id"
          : "custom_tool_use_id";
    const native = {
      type,
      id: "native-result",
      [field]: "native-call",
      is_error: true,
      content,
    };
    const history = [{ ...idle, id: "cursor" }, native, idle];
    const store = new InMemorySessionStore();
    store.set("5:agent|0:|3:env|0:|imported", {
      sessionId: "original",
      preserveTools: true,
      toolNames: [],
      pendingClientToolUseIds: [],
      lastUserMessageId: "old",
      lastEventId: "cursor",
    });
    const fake = createFakeClient({ histories: [history] });
    const events = await collect(agent(fake, store));
    expect(
      events.filter(
        (e) =>
          e.type === "RAW" &&
          "event" in e &&
          (e.event as { id?: string }).id === native.id,
      ),
    ).toEqual([
      { type: "RAW", source: "claude-managed-agents", event: native },
    ]);
    expect(events.find((e) => e.type === "TOOL_CALL_RESULT")).toMatchObject({
      messageId: native.id,
      toolCallId: "native-call",
      content: content.map((claudeManagedAgents) => ({
        metadata: { claudeManagedAgents, isError: true },
      })),
    });
    expect(fake.sent).toEqual([]);
    expect(store.get("5:agent|0:|3:env|0:|imported")?.lastEventId).toBe(
      "idle_end",
    );
  },
);

describe("captured child tool results (PNI-688)", () => {
  it.each(["ts", "py", "dotnet"])(
    "recovers %s canonical result after cold approval exactly once",
    async (language) => {
      const fixtures = JSON.parse(
        await readFile(
          new URL("../../../fixtures/child-results.json", import.meta.url),
          "utf8",
        ),
      );
      const row = fixtures[language];
      const call = row.root[0];
      const result = row.native.find(
        (event: { type: string }) => event.type === "agent.tool_result",
      );
      const child = call.session_thread_id;
      const store = new InMemorySessionStore();
      const fake = createFakeClient({
        histories: [[call]],
        streams: [[row.root[1], idle]],
        childHistories: { [child]: [...row.native, result] },
      });
      const events = await collect(
        agent(fake, store),
        input({
          resume: [
            {
              interruptId: call.id,
              status: "resolved",
              payload: row.root[1].result,
            },
          ],
        }),
      );
      expect(events.filter((e) => e.type === "TOOL_CALL_RESULT")).toEqual([
        expect.objectContaining({
          messageId: result.id,
          toolCallId: call.id,
          content: result.is_error
            ? JSON.stringify({ error: true, content: result.content[0].text })
            : result.content[0].text,
        }),
      ]);
      expect(events.filter((e) => e.type === "RAW")).toContainEqual(
        expect.objectContaining({
          event: expect.objectContaining({
            id: result.id,
            session_thread_id: child,
            is_error: result.is_error,
          }),
        }),
      );
      const restarted = createFakeClient({
        histories: [[...row.root, idle, result]],
        childHistories: { [child]: row.native },
      });
      const replay = await collect(agent(restarted, store));
      expect(replay.filter((e) => e.type === "TOOL_CALL_RESULT")).toEqual([]);
      expect(replay.at(-1)?.type).toBe("RUN_FINISHED");
    },
  );

  it("does not synthesize from confirmation, prose, or unrelated child results", async () => {
    const call = { ...approval("child-call"), session_thread_id: "child" };
    const fake = createFakeClient({
      histories: [
        [
          call,
          {
            type: "user.tool_confirmation",
            id: "confirmed",
            tool_use_id: call.id,
            result: "allow",
          },
          idle,
        ],
      ],
      childHistories: {
        child: [
          {
            type: "agent.tool_result",
            id: "foreign",
            tool_use_id: "other-call",
            content: [{ type: "text", text: "wrong" }],
          },
          {
            type: "agent.tool_result",
            id: "wrong-scope",
            tool_use_id: call.id,
            session_thread_id: "other-child",
            content: [{ type: "text", text: "wrong" }],
          },
          {
            type: "agent.message",
            id: "prose",
            content: [{ type: "text", text: "Done!" }],
          },
        ],
      },
    });
    const events = await collect(agent(fake));
    expect(events.filter((e) => e.type === "TOOL_CALL_RESULT")).toEqual([]);
    expect(events.at(-1)?.type).toBe("RUN_FINISHED");
  });
});

it("recovers a late child result after a serialized-store restart past the root cursor", async () => {
  const call = { ...approval("late-call"), session_thread_id: "child" };
  let saved: string | undefined;
  const store = {
    get: () => (saved ? JSON.parse(saved) : undefined),
    set: (_key: string, record: unknown) => {
      saved = JSON.stringify(record);
    },
    delete: () => {
      saved = undefined;
    },
  };
  const make = (fake: ReturnType<typeof createFakeClient>) =>
    new ManagedAgentsAgent({
      managedAgentId: "agent",
      environmentId: "env",
      client: fake.client,
      sessionStore: store,
      resolveSession: () => ({
        sessionId: "original",
        lastUserMessageId: "old",
      }),
    });
  const first = await collect(
    make(
      createFakeClient({
        histories: [[call, idle]],
        childHistories: { child: [] },
      }),
    ),
  );
  expect(first.filter((e) => e.type === "TOOL_CALL_RESULT")).toEqual([]);
  const result = {
    id: "late-result",
    type: "agent.tool_result",
    tool_use_id: call.id,
    content: [{ type: "text", text: "exact result" }],
  };
  const second = await collect(
    make(
      createFakeClient({
        histories: [[call, idle]],
        childHistories: { child: [result] },
      }),
    ),
  );
  expect(second.filter((e) => e.type === "TOOL_CALL_RESULT")).toEqual([
    expect.objectContaining({
      toolCallId: call.id,
      messageId: result.id,
      content: "exact result",
    }),
  ]);
  const third = await collect(
    make(
      createFakeClient({
        histories: [[call, idle, result]],
        childHistories: { child: [result] },
      }),
    ),
  );
  expect(third.filter((e) => e.type === "TOOL_CALL_RESULT")).toEqual([]);
});

it("persists transcript-known child results when the next reload omits the transcript", async () => {
  const call = { ...approval("known-child-call"), session_thread_id: "child" };
  const result = {
    id: "known-result",
    type: "agent.tool_result",
    tool_use_id: call.id,
    content: [{ type: "text", text: "done" }],
  };
  const store = new InMemorySessionStore();
  const make = () =>
    agent(
      createFakeClient({
        histories: [[call, idle]],
        childHistories: { child: [result] },
      }),
      store,
    );
  const first = await collect(
    make(),
    input({
      messages: [
        { role: "tool", id: result.id, toolCallId: call.id, content: "done" },
      ],
    }),
  );
  expect(first.filter((e) => e.type === "TOOL_CALL_RESULT")).toEqual([]);
  const second = await collect(make(), input({ messages: [] }));
  expect(second.at(-1)?.type).toBe("RUN_FINISHED");
  expect(second.filter((e) => e.type === "TOOL_CALL_RESULT")).toEqual([]);
});

it.each([false, true])(
  "tracks initial child results across restart (root cross-post: %s)",
  async (crossPosted) => {
    const call = { ...approval("initial-child"), session_thread_id: "child" };
    const result = {
      id: "initial-result",
      type: "agent.tool_result",
      tool_use_id: call.id,
      content: [{ type: "text", text: "done" }],
    };
    const store = new InMemorySessionStore();
    const initial = new ManagedAgentsAgent({
      managedAgentId: "agent",
      environmentId: "env",
      sessionStore: store,
      toolConfirmation: "allow",
      client: createFakeClient({
        streams: [[call, ...(crossPosted ? [result] : []), idle]],
        childHistories: { child: [result] },
      }).client,
    });
    const events = await collect(initial);
    expect(events.filter((e) => e.type === "TOOL_CALL_RESULT")).toHaveLength(1);
    expect(events.at(-1)?.type).toBe("RUN_FINISHED");
    const restarted = agent(
      createFakeClient({
        histories: [[call, idle]],
        childHistories: { child: [result] },
      }),
      store,
    );
    const replay = await collect(restarted, input({ messages: [] }));
    expect(replay.at(-1)?.type).toBe("RUN_FINISHED");
    expect(replay.filter((e) => e.type === "TOOL_CALL_RESULT")).toEqual([]);
  },
);

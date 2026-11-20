import { describe, it, expect } from "vitest";
import { lastValueFrom, toArray } from "rxjs";
import { ManagedAgentsAgent } from "../agent";
import {
  STATE_HEADER,
  STATE_TOOL,
  stateText,
  stateCommit,
  stateTool,
  stateToolDefinition,
  restoreStateHistory,
  parseState,
  acceptState,
} from "../state";
import { InMemorySessionStore } from "../sessions";
import { createFakeClient } from "./fake-client";
import type { RunAgentInput } from "@ag-ui/client";
import type { SessionRecord } from "../types";
const idle = {
  id: "idle",
  type: "session.status_idle",
  stop_reason: { type: "end_turn" },
};
const input = (
  state: unknown = { secret: "state-only-unique-692", obsolete: true },
): RunAgentInput => ({
  threadId: "thread",
  runId: "run",
  state,
  messages: [
    {
      id: "u1",
      role: "user",
      content: "Read the shared value and update the board.",
    },
  ],
  tools: [],
  context: [],
  forwardedProps: {},
});
const agent = (fake: ReturnType<typeof createFakeClient>, extra = {}) =>
  new ManagedAgentsAgent({
    managedAgentId: "agent",
    environmentId: "env",
    client: fake.client,
    ...extra,
  });
const collect = (a: ManagedAgentsAgent, i = input()) =>
  lastValueFrom(a.run(i).pipe(toArray()));
const record = (): SessionRecord => ({
  sessionId: "sesn_1",
  toolNames: [],
  pendingClientToolUseIds: [],
});
describe("native committed shared state", () => {
  it.each([null, "allow", "deny"] as const)(
    "delivers changed context with a recovered state result before inference (approval sibling=%s)",
    async (sibling) => {
      const history = [
        {
          id: "write",
          type: "agent.custom_tool_use",
          name: STATE_TOOL,
          input: {
            operation: "replace",
            expectedRevision: 0,
            state: { counter: 2 },
          },
        },
        ...(sibling
          ? [
              {
                id: "approval",
                type: "agent.tool_use",
                name: "bash",
                input: {},
                evaluated_permission: "ask",
              },
            ]
          : []),
      ];
      const fake = createFakeClient({
        histories: [history, history],
        streams: [[], [idle]],
        agentTools: [stateToolDefinition()],
        sendResults: [new Error("offline")],
      });
      const store = new InMemorySessionStore();
      const config = {
        sessionStore: store,
        resolveSession: () => ({ sessionId: "sesn_1" }),
      };
      const value: RunAgentInput = {
        ...input(null),
        messages: [],
        context: [{ description: "required", value: "new runtime guidance" }],
        ...(sibling
          ? {
              resume: [
                {
                  interruptId: "approval",
                  status: "resolved",
                  payload: sibling,
                },
              ],
            }
          : {}),
      };
      expect((await collect(agent(fake, config), value)).at(-1)?.type).toBe(
        "RUN_ERROR",
      );
      const cached = store.get("5:agent|0:|3:env|0:|thread");
      expect(cached).toBeDefined();
      expect(cached?.runtimeContext).toBeUndefined();
      expect(cached?.sharedState).toBeUndefined();
      expect(fake.sent).toEqual([]);
      const events = await collect(agent(fake, config), value);
      expect(events.at(-1)?.type).toBe("RUN_FINISHED");
      expect(fake.sent[0]).toMatchObject({
        sessionId: "sesn_1",
        events: [
          {
            type: "user.custom_tool_result",
            custom_tool_use_id: "write",
            is_error: false,
          },
          {
            type: "system.message",
            content: [
              {
                type: "text",
                text: expect.stringContaining(JSON.stringify(value.context)),
              },
            ],
          },
        ],
      });
      expect(fake.sent).toHaveLength(sibling ? 2 : 1);
      if (sibling)
        expect(fake.sent[1].events).toEqual([
          {
            type: "user.tool_confirmation",
            tool_use_id: "approval",
            result: sibling,
          },
        ]);
      expect(store.get("5:agent|0:|3:env|0:|thread")?.runtimeContext).toBe(
        JSON.stringify(value.context),
      );
      expect(
        store.get("5:agent|0:|3:env|0:|thread")?.sharedState?.state,
      ).toEqual({ counter: 2 });
    },
  );

  it.each(["unknown", "duplicate"] as const)(
    "rejects %s resume before recovered state or context side effects",
    async (invalid) => {
      const fake = createFakeClient({
        histories: [
          [
            {
              id: "write",
              type: "agent.custom_tool_use",
              name: STATE_TOOL,
              input: {
                operation: "replace",
                expectedRevision: 0,
                state: { counter: 2 },
              },
            },
            {
              id: "approval",
              type: "agent.tool_use",
              name: "bash",
              input: {},
              evaluated_permission: "ask",
            },
          ],
        ],
        streams: [[]],
        agentTools: [stateToolDefinition()],
      });
      const store = new InMemorySessionStore();
      const value: RunAgentInput = {
        ...input(null),
        messages: [],
        context: [{ description: "required", value: "new runtime guidance" }],
        resume: (invalid === "unknown"
          ? ["unknown"]
          : ["approval", "approval"]
        ).map((interruptId) => ({
          interruptId,
          status: "resolved",
          payload: "allow",
        })),
      };
      const events = await collect(
        agent(fake, {
          sessionStore: store,
          resolveSession: () => ({ sessionId: "sesn_1" }),
        }),
        value,
      );
      expect(events.at(-1)).toMatchObject({
        type: "RUN_ERROR",
        code: "invalid_resume",
      });
      expect(fake.sent).toEqual([]);
      expect(fake.spies.update).not.toHaveBeenCalled();
      const cached = store.get("5:agent|0:|3:env|0:|thread");
      expect(cached?.runtimeContext).toBeUndefined();
      expect(cached?.sharedState).toBeUndefined();
      expect(cached?.pendingClientToolUseIds).toEqual(["write"]);
      expect(cached?.pendingConfirmations).toEqual([
        expect.objectContaining({ id: "approval" }),
      ]);
      expect(events.some((event) => event.type === "TOOL_CALL_RESULT")).toBe(
        false,
      );
      expect(events.some((event) => event.type === "STATE_SNAPSHOT")).toBe(
        false,
      );
    },
  );

  it("sends state only to native system context, executes merge patch, and emits committed state", async () => {
    const fake = createFakeClient({
      streams: [
        [
          {
            id: "write",
            type: "agent.custom_tool_use",
            name: STATE_TOOL,
            input: {
              operation: "merge_patch",
              expectedRevision: 1,
              patch: { obsolete: null, board: { count: 2 } },
            },
          },
          idle,
        ],
      ],
    });
    const events = await collect(agent(fake));
    const native = fake.sent.flatMap((s) => s.events) as any[];
    const initial = native.find((e) => e.type === "system.message");
    expect(initial.content[0].text).toContain("state-only-unique-692");
    expect(native.find((e) => e.type === "user.message").content).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: expect.stringContaining("state-only-unique-692"),
        }),
      ]),
    );
    const result = native.find((e) => e.type === "user.custom_tool_result");
    const commit = parseState(result.content, record());
    expect(commit?.revision).toBe(2);
    expect(commit?.state).toEqual({
      secret: "state-only-unique-692",
      board: { count: 2 },
    });
    expect(
      events.filter((e) => e.type === "STATE_SNAPSHOT").at(-1),
    ).toMatchObject({ snapshot: commit?.state });
    expect(events.at(-1)?.type).toBe("RUN_FINISHED");
  });
  it("does not emit a failed native write as committed state", async () => {
    const fake = createFakeClient({
      sendResults: [undefined, new Error("offline")],
      streams: [
        [
          {
            id: "write",
            type: "agent.custom_tool_use",
            name: STATE_TOOL,
            input: {
              operation: "replace",
              expectedRevision: 1,
              state: { bad: true },
            },
          },
          idle,
        ],
      ],
    });
    const events = await collect(agent(fake));
    expect(events.filter((e) => e.type === "STATE_SNAPSHOT")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      type: "RUN_ERROR",
      code: "tool_result_delivery_failed",
    });
  });
  it("recovers a successful native write after adapter restart without historical state fabrication", async () => {
    const r = record();
    const first = stateCommit(r, { board: { count: 1 } });
    acceptState(r, first);
    const second = stateCommit(r, { board: { count: 3 } });
    const history = [
      {
        id: "snapshot",
        type: "system.message",
        content: [{ type: "text", text: stateText(first) }],
      },
      {
        id: "call",
        type: "agent.custom_tool_use",
        name: STATE_TOOL,
        input: {},
      },
      {
        id: "result",
        type: "user.custom_tool_result",
        custom_tool_use_id: "call",
        is_error: false,
        content: [{ type: "text", text: stateText(second) }],
      },
      idle,
    ];
    const fake = createFakeClient({ histories: [history], streams: [[]] });
    const events = await collect(
      agent(fake, { resolveSession: () => ({ sessionId: "sesn_1" }) }),
      input(null),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "STATE_SNAPSHOT",
        snapshot: { board: { count: 3 } },
      }),
    );
    expect(fake.sent).toHaveLength(0);
  });
  it("clears by replacement and deletes nested members by merge patch", async () => {
    const r = record();
    acceptState(
      r,
      stateCommit(r, { nested: { keep: 1, remove: 2 }, arr: [1] }),
    );
    const tool = stateTool(r);
    const text = await tool.handler({
      operation: "merge_patch",
      expectedRevision: 1,
      patch: { nested: { remove: null }, arr: [2] },
    });
    const next = parseState([{ type: "text", text }], r)!;
    expect(next.state).toEqual({ nested: { keep: 1 }, arr: [2] });
    acceptState(r, next);
    const empty = await tool.handler({
      operation: "replace",
      expectedRevision: 2,
      state: {},
    });
    expect(parseState([{ type: "text", text: empty }], r)?.state).toEqual({});
    expect(() =>
      tool.handler({ operation: "replace", expectedRevision: 1, state: {} }),
    ).toThrow("Stale");
  });
  it("rejects unsafe keys and unrelated state records", () => {
    const r = record();
    expect(() =>
      stateCommit(r, JSON.parse('{"__proto__":{"polluted":true}}')),
    ).toThrow();
    expect(
      parseState([{ type: "text", text: STATE_HEADER + '{"version":2}' }], r),
    ).toBeUndefined();
  });
});

it("completes an original pending internal state call after cold import", async () => {
  const r = record();
  const snapshot = stateCommit(r, { count: 1 });
  const fake = createFakeClient({
    agentTools: [stateToolDefinition()],
    histories: [
      [
        {
          id: "initial",
          type: "system.message",
          content: [{ type: "text", text: stateText(snapshot) }],
        },
        {
          id: "pending-write",
          type: "agent.custom_tool_use",
          name: STATE_TOOL,
          input: {
            operation: "merge_patch",
            expectedRevision: 1,
            patch: { count: 2 },
          },
        },
        {
          id: "pending",
          type: "session.status_idle",
          stop_reason: {
            type: "requires_action",
            event_ids: ["pending-write"],
          },
        },
      ],
    ],
    streams: [[idle]],
  });
  const events = await collect(
    agent(fake, { resolveSession: () => ({ sessionId: "sesn_1" }) }),
    input(null),
  );
  expect(fake.sent.flatMap((s) => s.events)).toContainEqual(
    expect.objectContaining({
      type: "user.custom_tool_result",
      custom_tool_use_id: "pending-write",
      is_error: false,
    }),
  );
  expect(
    events.filter((e) => e.type === "STATE_SNAPSHOT").at(-1),
  ).toMatchObject({ snapshot: { count: 2 } });
  expect(events.at(-1)).toMatchObject({ type: "RUN_FINISHED" });
  expect(events.at(-1)).not.toHaveProperty("outcome.interrupts");
});

it("does not treat a cache or a result missing explicit success as native state", async () => {
  const r = record();
  r.sharedState = stateCommit(r, { poison: true });
  const c = stateCommit(r, { bad: true });
  await restoreStateHistory(
    createFakeClient().client,
    r,
    [
      {
        id: "call",
        type: "agent.custom_tool_use",
        name: STATE_TOOL,
        input: {},
      },
      {
        id: "missing-success",
        type: "user.custom_tool_result",
        custom_tool_use_id: "call",
        content: [{ type: "text", text: stateText(c) }],
      },
    ] as any[],
    AbortSignal.timeout(1000),
  );
  expect(r.sharedState).toBeUndefined();
});

it("rejects reserved frontend names on imported runs before dispatch", async () => {
  const fake = createFakeClient();
  const value = input(null);
  value.tools = [{ name: STATE_TOOL, description: "hijack", parameters: {} }];
  const events = await collect(
    agent(fake, { resolveSession: () => ({ sessionId: "sesn_1" }) }),
    value,
  );
  expect(events.at(-1)?.type).toBe("RUN_ERROR");
  expect(fake.sent).toHaveLength(0);
});

it("rejects conflicting base and duplicate imported reserved definitions", async () => {
  const collision = {
    type: "custom",
    name: STATE_TOOL,
    description: "other",
    input_schema: { type: "object" },
  };
  const fake = createFakeClient({ agentTools: [collision] });
  expect((await collect(agent(fake))).at(-1)?.type).toBe("RUN_ERROR");
  expect(fake.sent).toHaveLength(0);
  const imported = createFakeClient({
    agentTools: [stateToolDefinition(), collision],
  });
  const value = input(null);
  value.messages[0].id = "u2";
  expect(
    (
      await collect(
        agent(imported, {
          resolveSession: () => ({
            sessionId: "sesn_1",
            lastUserMessageId: "u1",
          }),
        }),
        value,
      )
    ).at(-1)?.type,
  ).toBe("RUN_ERROR");
  expect(imported.sent).toHaveLength(0);
});

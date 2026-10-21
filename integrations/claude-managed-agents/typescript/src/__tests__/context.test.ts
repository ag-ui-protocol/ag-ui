import Anthropic from "@anthropic-ai/sdk";
import { expect, it } from "vitest";
import { lastValueFrom, toArray } from "rxjs";
import type { RunAgentInput } from "@ag-ui/client";
import { ManagedAgentsAgent } from "../agent";
import { InMemorySessionStore } from "../sessions";
import { createFakeClient } from "./fake-client";

const idle = {
  type: "session.status_idle",
  id: "idle",
  stop_reason: { type: "end_turn" },
};
const context = [
  {
    description: "A2UI catalog",
    value: "copilotkit://app-dashboard-catalog — FlightCard",
  },
  { description: "A2UI schema", value: '  {"component":"FlightCard"}\n日本語' },
];
const input = (overrides: Partial<RunAgentInput> = {}): RunAgentInput => ({
  threadId: "t",
  runId: "r",
  messages: [{ id: "u1", role: "user", content: "show flights" }],
  tools: [],
  context,
  state: {},
  forwardedProps: {},
  ...overrides,
});
const collect = (agent: ManagedAgentsAgent, value = input()) =>
  lastValueFrom(agent.run(value).pipe(toArray()));
const setup = (
  options: Parameters<typeof createFakeClient>[0] = {},
  store = new InMemorySessionStore(),
) => {
  const fake = createFakeClient({
    streams: [[idle], [idle], [idle], [idle]],
    ...options,
  });
  const agent = new ManagedAgentsAgent({
    managedAgentId: "a",
    environmentId: "e",
    client: fake.client,
    sessionStore: store,
  });
  return { fake, agent, store };
};
const expectedContext = (entries = context) => ({
  type: "system.message",
  content: [
    { type: "text", text: expect.stringContaining(JSON.stringify(entries)) },
  ],
});

// Use the real SDK with an in-process transport: no provider requests or recordings.
it("puts every context entry on the actual native HTTP request without changing the user message", async () => {
  const requests: { events: unknown[] }[] = [];
  const client = new Anthropic({
    apiKey: "test",
    maxRetries: 0,
    fetch: async (url, init) => {
      if (String(url).includes("/events/stream"))
        return new Response(
          `event: session.status_idle\ndata: ${JSON.stringify(idle)}\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (body.events) requests.push(body);
      return Response.json({ id: "native", data: [] });
    },
  });
  const agent = new ManagedAgentsAgent({
    managedAgentId: "a",
    environmentId: "e",
    client,
  });
  const value = input();
  const original = structuredClone(value);
  const events = await collect(agent, value);
  expect(events.at(-1)?.type).toBe("RUN_FINISHED");
  expect(requests).toEqual([
    {
      events: [
        {
          type: "user.message",
          content: [{ type: "text", text: "show flights" }],
        },
        expectedContext(),
      ],
    },
  ]);
  expect(value).toEqual(original);
});

it("forwards fresh context after a cold store restart and clears it without crossing threads", async () => {
  const { fake, agent, store } = setup();
  await collect(agent);
  const next = input({
    messages: [
      { id: "u1", role: "user", content: "show flights" },
      { id: "u2", role: "user", content: "next" },
    ],
    context: [{ description: "catalog", value: "updated" }],
  });
  const coldStore = new InMemorySessionStore();
  coldStore.set(
    "1:a|0:|1:e|0:|t",
    JSON.parse(JSON.stringify(store.get("1:a|0:|1:e|0:|t"))),
  );
  const restored = new ManagedAgentsAgent({
    managedAgentId: "a",
    environmentId: "e",
    client: fake.client,
    sessionStore: coldStore,
  });
  await collect(restored, next);
  expect(fake.sent[1].events.at(-1)).toEqual(expectedContext(next.context));
  await collect(
    restored,
    input({
      messages: [{ id: "u3", role: "user", content: "clear" }],
      context: [],
    }),
  );
  expect(fake.sent[2].events.at(-1)).toEqual(expectedContext([]));
  await collect(restored, input({ threadId: "other", context: [] }));
  expect(fake.sent[3].events).toHaveLength(1);
});

it("attaches context to the tool-result request before the separate follow-up", async () => {
  const fake = createFakeClient({
    histories: [
      [
        {
          type: "agent.custom_tool_use",
          id: "c",
          name: "render_a2ui",
          input: {},
        },
      ],
    ],
    streams: [[idle]],
  });
  const agent = new ManagedAgentsAgent({
    managedAgentId: "a",
    environmentId: "e",
    client: fake.client,
    resolveSession: () => ({ sessionId: "original", lastUserMessageId: "old" }),
  });
  const events = await collect(
    agent,
    input({
      messages: [
        { id: "old", role: "user", content: "old" },
        { id: "result", role: "tool", toolCallId: "c", content: "ok" },
        { id: "new", role: "user", content: "next" },
      ],
    }),
  );
  expect(events.at(-1)?.type).toBe("RUN_FINISHED");
  expect(fake.sent[0].events).toEqual([
    expect.objectContaining({ type: "user.custom_tool_result" }),
    expectedContext(),
  ]);
  expect(fake.sent[1].events).toEqual([
    { type: "user.message", content: [{ type: "text", text: "next" }] },
  ]);
});

it("retries context after a rejected request instead of recording it as delivered", async () => {
  const { fake, agent, store } = setup({
    sendResults: [new Error("offline"), undefined],
  });
  expect((await collect(agent)).at(-1)?.type).toBe("RUN_ERROR");
  expect(store.get("1:a|0:|1:e|0:|t")?.runtimeContext).toBeUndefined();
  expect((await collect(agent)).at(-1)?.type).toBe("RUN_FINISHED");
  expect(fake.sent[0].events.at(-1)).toEqual(expectedContext());
});

it("does not repeat unchanged context on subsequent user turns", async () => {
  const { fake, agent } = setup();
  await collect(agent);
  await collect(
    agent,
    input({ messages: [{ id: "u2", role: "user", content: "next" }] }),
  );
  expect(fake.sent[1].events).toHaveLength(1);
});

it("does not manufacture a turn for context-only reconnects", async () => {
  const fake = createFakeClient({ histories: [[idle]], streams: [[]] });
  const agent = new ManagedAgentsAgent({
    managedAgentId: "a",
    environmentId: "e",
    client: fake.client,
    resolveSession: () => ({ sessionId: "original", lastUserMessageId: "u1" }),
  });
  expect((await collect(agent)).at(-1)?.type).toBe("RUN_FINISHED");
  expect(fake.sent).toEqual([]);
});

it("rejects context injection into a child without leaking it to the primary thread", async () => {
  const fake = createFakeClient({
    histories: [
      [{ type: "agent.custom_tool_use", id: "c", name: "tool", input: {} }],
    ],
    streams: [[]],
  });
  const agent = new ManagedAgentsAgent({
    managedAgentId: "a",
    environmentId: "e",
    client: fake.client,
    resolveSession: () => ({
      sessionId: "original",
      sessionThreadId: "child",
      lastUserMessageId: "u1",
    }),
  });
  const events = await collect(
    agent,
    input({
      messages: [{ id: "tool", role: "tool", toolCallId: "c", content: "ok" }],
    }),
  );
  expect(events.at(-1)).toMatchObject({
    type: "RUN_ERROR",
    code: "context_delivery_unsupported",
  });
  expect(fake.sent).toEqual([]);
});

it("rejects changed context on an approval-only resume before sending the approval", async () => {
  const fake = createFakeClient({
    histories: [
      [
        {
          type: "agent.tool_use",
          id: "c",
          name: "bash",
          input: {},
          evaluated_permission: "ask",
        },
      ],
    ],
    streams: [[]],
  });
  const agent = new ManagedAgentsAgent({
    managedAgentId: "a",
    environmentId: "e",
    client: fake.client,
    resolveSession: () => ({ sessionId: "original", lastUserMessageId: "u1" }),
  });
  const events = await collect(
    agent,
    input({
      resume: [{ interruptId: "c", status: "resolved", payload: "allow" }],
    }),
  );
  expect(events.at(-1)).toMatchObject({
    type: "RUN_ERROR",
    code: "context_delivery_unsupported",
  });
  expect(fake.sent).toEqual([]);
});

it.each(["clear", "approval"])(
  "restores the latest snapshot on native import: %s",
  async (mode) => {
    const nativeContext = (id: string, entries: RunAgentInput["context"]) => ({
      type: "system.message",
      id,
      content: [
        {
          type: "text",
          text:
            "AG-UI runtime context snapshot. Replace all earlier AG-UI runtime context snapshots with this complete list; an empty list clears them.\n" +
            JSON.stringify(entries),
        },
      ],
    });
    const history = [
      nativeContext("older", [{ description: "old", value: "obsolete" }]),
      nativeContext("latest", context),
      ...(mode === "approval"
        ? [
            {
              type: "agent.tool_use",
              id: "c",
              name: "bash",
              input: {},
              evaluated_permission: "ask",
            },
          ]
        : []),
    ];
    const fake = createFakeClient({ histories: [history], streams: [[idle]] });
    const agent = new ManagedAgentsAgent({
      managedAgentId: "a",
      environmentId: "e",
      client: fake.client,
      resolveSession: () => ({
        sessionId: "original",
        lastUserMessageId: "u1",
      }),
    });
    const value =
      mode === "approval"
        ? input({
            resume: [
              { interruptId: "c", status: "resolved", payload: "allow" },
            ],
          })
        : input({
            context: [],
            messages: [{ id: "u2", role: "user", content: "clear" }],
          });
    expect((await collect(agent, value)).at(-1)?.type).toBe("RUN_FINISHED");
    if (mode === "clear")
      expect(fake.sent[0].events.at(-1)).toEqual(expectedContext([]));
    else
      expect(fake.sent[0].events).toEqual([
        { type: "user.tool_confirmation", tool_use_id: "c", result: "allow" },
      ]);
  },
);

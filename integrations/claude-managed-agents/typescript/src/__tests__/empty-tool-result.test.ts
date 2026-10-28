import { EventType, type RunAgentInput } from "@ag-ui/client";
import { lastValueFrom, toArray } from "rxjs";
import { expect, it } from "vitest";
import { ManagedAgentsAgent } from "../agent";
import { InMemorySessionStore } from "../sessions";
import { createFakeClient, withoutStateSnapshots } from "./fake-client";

const key = "7:agent_1|0:|5:env_1|0:|thread_1";
const call = {
  type: "agent.custom_tool_use",
  id: "chart_1",
  name: "chart",
  input: {},
};
const idle = {
  type: "session.status_idle",
  id: "idle_1",
  stop_reason: { type: "end_turn" },
};

it.each([
  { content: "", expected: [] },
  { content: [], expected: [] },
  { content: [{ type: "text", text: "" }], expected: [] },
  {
    content: "  answered\n",
    expected: [{ type: "text", text: "  answered\n" }],
  },
  {
    content: "",
    error: "Failed",
    expected: [{ type: "text", text: "Failed" }],
  },
  {
    content: [
      { type: "text", text: "" },
      { type: "text", text: " \n" },
      {
        type: "image",
        source: { type: "file", value: "file_1", provider: "anthropic" },
      },
    ],
    expected: [
      { type: "text", text: " \n" },
      { type: "image", source: { type: "file", file_id: "file_1" } },
    ],
  },
] as const)(
  "continues the native call once with $content",
  async ({ content, expected, ...rest }) => {
    const result = {
      type: "user.custom_tool_result",
      custom_tool_use_id: "chart_1",
      content: expected,
      is_error: "error" in rest,
    };
    const fake = createFakeClient({
      histories: [[call], [call, { ...result, id: "result_1" }, idle]],
      streams: [[idle], [idle]],
    });
    const store = new InMemorySessionStore();
    await store.set(key, {
      sessionId: "sesn_original",
      toolNames: [],
      pendingClientToolUseIds: ["chart_1"],
      lastUserMessageId: "u1",
    });
    const agent = () =>
      new ManagedAgentsAgent({
        managedAgentId: "agent_1",
        environmentId: "env_1",
        client: fake.client,
        sessionStore: store,
      });
    const input: RunAgentInput = {
      threadId: "thread_1",
      runId: "run_1",
      state: {},
      context: [],
      tools: [],
      forwardedProps: {},
      messages: [
        { id: "u1", role: "user", content: "Chart" },
        {
          id: "t1",
          role: "tool",
          toolCallId: "chart_1",
          content: JSON.parse(JSON.stringify(content)),
          ...rest,
        },
      ],
    };
    // Duplicate frontend delivery within one request still resolves only once.
    input.messages.push({ ...input.messages[1]!, id: "t1-copy" });
    const events = await lastValueFrom(agent().run(input).pipe(toArray()));
    expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
    expect(
      fake.sent.map((send) => ({
        ...send,
        events: withoutStateSnapshots(send.events),
      })),
    ).toEqual([{ sessionId: "sesn_original", events: [result] }]);
    expect((await store.get(key))?.pendingClientToolUseIds).toEqual([]);
    // Rebuild from native history after losing local delivery bookkeeping.
    await store.set(key, {
      sessionId: "sesn_original",
      toolNames: [],
      pendingClientToolUseIds: ["chart_1"],
      lastUserMessageId: "u1",
    });
    await lastValueFrom(
      agent()
        .run({ ...input, runId: "run_2" })
        .pipe(toArray()),
    );
    expect(fake.sent).toHaveLength(1);
    expect(fake.spies.create).not.toHaveBeenCalled();
    expect((await store.get(key))?.pendingClientToolUseIds).toEqual([]);
  },
);

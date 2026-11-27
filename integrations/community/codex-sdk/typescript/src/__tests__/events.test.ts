import { describe, expect, it } from "vitest";
import { AbstractAgent } from "@ag-ui/client";
import { EventType, type BaseEvent } from "@ag-ui/core";
import { EventSchema } from "@ag-ui/core/schemas";
import { from } from "rxjs";
import type { ThreadEvent, ThreadItem, Usage } from "@openai/codex-sdk";
import { CodexEventTranslator } from "../events";

const usage: Usage = {
  input_tokens: 12,
  cached_input_tokens: 3,
  cache_write_input_tokens: 2,
  output_tokens: 8,
  reasoning_output_tokens: 4,
};
const terminal: ThreadEvent = { type: "turn.completed", usage };
const message = (id: string, text: string): ThreadItem => ({
  id,
  type: "agent_message",
  text,
});
const completed = (item: ThreadItem): ThreadEvent => ({
  type: "item.completed",
  item,
});
const updated = (item: ThreadItem): ThreadEvent => ({
  type: "item.updated",
  item,
});
const started = (item: ThreadItem): ThreadEvent => ({
  type: "item.started",
  item,
});

function translate(
  input: ThreadEvent[],
  options = {},
): { translator: CodexEventTranslator; events: BaseEvent[] } {
  const translator = new CodexEventTranslator({ runId: "run", ...options });
  const events = input.flatMap((event) => translator.push(event));
  for (const event of events)
    expect(EventSchema.safeParse(event).success).toBe(true);
  return { translator, events };
}

async function reduce(events: BaseEvent[]) {
  class TestAgent extends AbstractAgent {
    run() {
      return from(events);
    }
  }
  const agent = new TestAgent({ threadId: "public-thread" });
  await agent.runAgent({ runId: "run" });
  return agent.messages;
}

function wrapped(events: BaseEvent[]): BaseEvent[] {
  return [
    { type: EventType.RUN_STARTED, threadId: "public-thread", runId: "run" },
    ...events,
    { type: EventType.RUN_FINISHED, threadId: "public-thread", runId: "run" },
  ];
}

describe("CodexEventTranslator", () => {
  it.each([
    {
      type: "command_execution",
      command: "pwd",
      aggregated_output: "",
      status: { privateMetadata: "secret" },
    },
    {
      type: "command_execution",
      command: "pwd",
      aggregated_output: "",
      status: "completed",
      exit_code: { privateMetadata: "secret" },
    },
    {
      type: "command_execution",
      command: { privateMetadata: "secret" },
      aggregated_output: "",
      status: "completed",
    },
    {
      type: "command_execution",
      command: "pwd",
      aggregated_output: { privateMetadata: "secret" },
      status: "completed",
    },
    {
      type: "mcp_tool_call",
      server: "local",
      tool: "lookup",
      status: { privateMetadata: "secret" },
      arguments: {},
    },
    {
      type: "mcp_tool_call",
      server: "local",
      tool: "lookup",
      status: "completed",
      arguments: {},
      result: { content: { length: 1, privateMetadata: "secret" } },
    },
    {
      type: "mcp_tool_call",
      server: "local",
      tool: "lookup",
      status: "failed",
      arguments: {},
      error: { message: { privateMetadata: "secret" } },
    },
    {
      type: "file_change",
      status: "completed",
      changes: [{ path: "safe.txt", kind: { privateMetadata: "secret" } }],
    },
    { type: "file_change", status: "completed", changes: [null] },
    {
      type: "file_change",
      status: "completed",
      changes: { privateMetadata: "secret" },
    },
    {
      type: "todo_list",
      items: [{ text: "Task", completed: { privateMetadata: "secret" } }],
    },
    { type: "todo_list", items: [null] },
    { type: "todo_list", items: { privateMetadata: "secret" } },
    { type: "web_search", query: { privateMetadata: "secret" } },
  ])(
    "rejects malformed $type progress without emitting private fields",
    (item) => {
      const translator = new CodexEventTranslator({ runId: "run" });
      const event: ThreadEvent = JSON.parse(
        JSON.stringify({
          type: "item.completed",
          item: { id: "native-item", ...item },
        }),
      );
      expect(() => translator.push(event)).toThrowError(
        expect.objectContaining({
          code: "INVALID_SDK_EVENT",
          message: "Codex returned invalid progress fields.",
        }),
      );
    },
  );

  it("rejects revisions to completed messages without retaining their snapshots", () => {
    const translator = new CodexEventTranslator({ runId: "run" });
    translator.push(completed(message("a", "Original")));
    expect(translator.push(completed(message("a", "Original")))).toEqual([]);
    expect(() => translator.push(completed(message("a", "Changed")))).toThrow(
      "revised a completed message",
    );
  });

  it("rejects a revision to a completed item still waiting behind another item", () => {
    const translator = new CodexEventTranslator({ runId: "run" });
    translator.push(started(message("a", "First")));
    translator.push(completed(message("b", "Second")));
    expect(() =>
      translator.push(updated(message("b", "Second revised"))),
    ).toThrow("revised a completed message");
  });

  it("rejects invalid or inconsistent usage before terminal emission", () => {
    const translator = new CodexEventTranslator({ runId: "run" });
    expect(() =>
      translator.push({
        type: "turn.completed",
        usage: { ...usage, input_tokens: -1 },
      }),
    ).toThrow("token usage");
    expect(() =>
      translator.push({
        type: "turn.completed",
        usage: { ...usage, reasoning_output_tokens: 100 },
      }),
    ).toThrow("token usage");
  });

  it("appends aggregate snapshot suffixes once and reduces through the real client", async () => {
    const { translator, events } = translate([
      started(message("a", "Hel")),
      updated(message("a", "Hel")),
      updated(message("a", "Hello")),
      completed(message("a", "Hello")),
      completed(message("a", "Hello")),
      terminal,
      terminal,
    ]);
    const result = translator.finish();
    expect(
      events
        .filter((event) => event.type === EventType.TEXT_MESSAGE_CONTENT)
        .map((event) => EventSchema.parse(event))
        .map((event) =>
          event.type === EventType.TEXT_MESSAGE_CONTENT ? event.delta : "",
        ),
    ).toEqual(["Hel", "lo"]);
    expect(await reduce(wrapped(events))).toEqual([
      { id: "run:codex:a", role: "assistant", content: "Hello" },
    ]);
    expect(result.assistantMessages).toEqual([
      { id: "run:codex:a", role: "assistant", content: "Hello" },
    ]);
    expect(result.usage).toEqual({
      provider: "openai",
      inputTokens: 12,
      outputTokens: 8,
      totalTokens: 20,
      cachedInputTokens: 3,
      cacheWriteInputTokens: 2,
      reasoningTokens: 4,
    });
  });

  it("emits completed-only text and separate messages without duplicating final response", async () => {
    const { translator, events } = translate([
      completed(message("a", "First")),
      completed(message("b", "Second")),
      terminal,
    ]);
    expect(
      translator.finish().assistantMessages.map((entry) => entry.id),
    ).toEqual(["run:codex:a", "run:codex:b"]);
    expect(
      (await reduce(wrapped(events))).map((entry) => entry.content),
    ).toEqual(["First", "Second"]);
  });

  it("serializes overlapping native items in first-seen order", async () => {
    const translator = new CodexEventTranslator({ runId: "run" });
    const first = translator.push(started(message("a", "A")));
    expect(translator.push(started(message("b", "B")))).toEqual([]);
    expect(translator.push(completed(message("b", "Bravo")))).toEqual([]);
    const last = translator.push(completed(message("a", "Alpha")));
    translator.push(terminal);
    const events = [...first, ...last];
    let active: string | undefined;
    for (const event of events.map((event) => EventSchema.parse(event))) {
      if (event.type === EventType.TEXT_MESSAGE_START) {
        expect(active).toBeUndefined();
        active = event.messageId;
      } else if (event.type === EventType.TEXT_MESSAGE_CONTENT) {
        expect(event.messageId).toBe(active);
      } else if (event.type === EventType.TEXT_MESSAGE_END) {
        expect(event.messageId).toBe(active);
        active = undefined;
      }
    }
    expect(active).toBeUndefined();
    expect(
      (await reduce(wrapped(events))).map((entry) => entry.content),
    ).toEqual(["Alpha", "Bravo"]);
    expect(
      translator.finish().assistantMessages.map((entry) => entry.content),
    ).toEqual(["Alpha", "Bravo"]);
  });

  it.each(["", "new text"])(
    "rejects snapshot replacement or shrinkage %j",
    (text) => {
      const translator = new CodexEventTranslator({ runId: "run" });
      translator.push(updated(message("a", "existing")));
      expect(() => translator.push(completed(message("a", text)))).toThrow(
        "revised text",
      );
      expect(translator.close()).toEqual([
        { type: EventType.TEXT_MESSAGE_END, messageId: "run:codex:a" },
      ]);
      expect(translator.close()).toEqual([]);
    },
  );

  it("requires item completion rather than flushing unfinished messages at turn terminal", () => {
    const { translator } = translate([
      started(message("a", "A")),
      completed(message("b", "B")),
      terminal,
    ]);
    expect(() => translator.finish()).toThrow("unfinished message");
    expect(translator.close()).toEqual([
      { type: EventType.TEXT_MESSAGE_END, messageId: "run:codex:a" },
    ]);
  });

  it("requires a successful terminal and rejects fatal errors even after staged success", () => {
    const translator = new CodexEventTranslator({ runId: "run" });
    expect(() => translator.finish()).toThrow("without completing");
    translator.push(terminal);
    expect(() =>
      translator.push({ type: "error", message: "secret stderr" }),
    ).toThrow("could not complete");
    expect(() =>
      translator.push({
        type: "turn.failed",
        error: { message: "secret prompt" },
      }),
    ).toThrow("could not complete");
  });

  it("ignores reasoning summaries by default and renders opted-in summaries with public events", async () => {
    const input: ThreadEvent[] = [
      completed({ id: "r", type: "reasoning", text: "Public summary" }),
      completed(message("a", "Answer")),
      terminal,
    ];
    const hidden = translate(input);
    expect(hidden.events.map((event) => event.type)).toEqual([
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
    ]);
    const shown = translate(input, { showReasoning: true });
    expect(shown.events.slice(0, 5).map((event) => event.type)).toEqual([
      EventType.REASONING_START,
      EventType.REASONING_MESSAGE_START,
      EventType.REASONING_MESSAGE_CONTENT,
      EventType.REASONING_MESSAGE_END,
      EventType.REASONING_END,
    ]);
    const reduced = await reduce(wrapped(shown.events));
    expect(
      reduced
        .filter((entry) => entry.role === "assistant")
        .map((entry) => entry.content),
    ).toEqual(["Answer"]);
    expect(shown.translator.finish().assistantMessages).toEqual([
      { id: "run:codex:a", role: "assistant", content: "Answer" },
    ]);
  });

  it("projects all progress variants without frontend tools or arbitrary MCP payloads", () => {
    const items: ThreadItem[] = [
      {
        id: "c",
        type: "command_execution",
        command: "pwd",
        aggregated_output: "/scratch",
        status: "completed",
        exit_code: 0,
      },
      {
        id: "m",
        type: "mcp_tool_call",
        server: "local",
        tool: "lookup",
        arguments: { token: "secret" },
        result: {
          content: [{ type: "text", text: "private result" }],
          structured_content: { secret: true },
          _meta: "private meta",
        },
        status: "completed",
      },
      {
        id: "f",
        type: "file_change",
        changes: [{ path: "example.txt", kind: "add" }],
        status: "completed",
      },
      { id: "w", type: "web_search", query: "public query" },
      {
        id: "t",
        type: "todo_list",
        items: [{ text: "inspect", completed: true }],
      },
      { id: "e", type: "error", message: "private diagnostic" },
    ];
    const { translator, events } = translate([
      ...items.map(completed),
      terminal,
    ]);
    expect(events).toHaveLength(6);
    for (const event of events.map((event) => EventSchema.parse(event))) {
      expect(event.type).toBe(EventType.CUSTOM);
      if (event.type === EventType.CUSTOM) {
        expect(event.name).toBe("codex.item");
        expect(event.value.version).toBe(1);
      }
    }
    expect(JSON.stringify(events)).not.toMatch(
      /secret|private|_meta|structured_content/,
    );
    expect(translator.finish().assistantMessages).toEqual([]);
  });

  it("bounds progress payload bytes and marks truncation", () => {
    const { events } = translate(
      [
        completed({
          id: "c",
          type: "command_execution",
          command: "echo",
          aggregated_output: "💬".repeat(5000),
          status: "completed",
        }),
      ],
      { maxProgressBytes: 256 },
    );
    const event = EventSchema.parse(events[0]);
    expect(event.type).toBe(EventType.CUSTOM);
    if (event.type === EventType.CUSTOM) {
      expect(
        Buffer.byteLength(JSON.stringify(event.value), "utf8"),
      ).toBeLessThanOrEqual(256);
      expect(event.value.truncated).toBe(true);
    }
  });

  it("counts cumulative UTF-8 snapshot growth only once", () => {
    const translator = new CodexEventTranslator({
      runId: "run",
      maxTextBytes: 8,
    });
    translator.push(updated(message("a", "💬")));
    translator.push(updated(message("a", "💬")));
    translator.push(completed(message("a", "💬💬")));
    expect(() => translator.push(completed(message("b", "a")))).toThrow(
      "text output limit",
    );
  });

  it("bounds hidden reasoning text, native item count, and assistant history", () => {
    const hidden = new CodexEventTranslator({ runId: "run", maxTextBytes: 3 });
    expect(() =>
      hidden.push(completed({ id: "r", type: "reasoning", text: "long" })),
    ).toThrow("text output limit");
    const items = new CodexEventTranslator({ runId: "run", maxItems: 1 });
    items.push(completed(message("a", "A")));
    expect(() => items.push(completed(message("b", "B")))).toThrow(
      "native item limit",
    );
    const messages = new CodexEventTranslator({ runId: "run", maxMessages: 1 });
    messages.push(completed(message("a", "A")));
    expect(() => messages.push(completed(message("b", "B")))).toThrow(
      "message limit",
    );
  });

  it("closes only an emitted active lifecycle on failure", () => {
    const translator = new CodexEventTranslator({
      runId: "run",
      showReasoning: true,
    });
    translator.push(
      started({ id: "r", type: "reasoning", text: "Thinking summary" }),
    );
    translator.push(started(message("a", "not yet emitted")));
    expect(translator.close()).toEqual([
      { type: EventType.REASONING_MESSAGE_END, messageId: "run:codex:r" },
      { type: EventType.REASONING_END, messageId: "run:codex:r" },
    ]);
  });
});

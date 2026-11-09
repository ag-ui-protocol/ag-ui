import { Subject, firstValueFrom } from "rxjs";
import { toArray } from "rxjs/operators";
import {
  AGUI_METADATA_KEY,
  AssistantMessage,
  BaseEvent,
  EventType,
  Message,
  RunAgentInput,
} from "@ag-ui/core";
import { defaultApplyEvents } from "../default";
import { AbstractAgent } from "@/agent";
import type { AgentSubscriber } from "@/agent/subscriber";

// A tool call cut off by a backend or subagent failure is closed with a
// TOOL_CALL_END that carries `metadata["ag-ui"].aborted`. These tests pin what
// the reducer does with such a call: it is not announced for execution, it is
// not pending, and its raw arguments stay on the call as diagnostics.

const ABORTED = { [AGUI_METADATA_KEY]: { aborted: true } };

const input: RunAgentInput = {
  messages: [],
  state: {},
  threadId: "t",
  runId: "r",
  tools: [],
  context: [],
};

const createAgent = (messages: Message[] = []) =>
  ({ messages: messages.map((m) => ({ ...m })), state: {} }) as unknown as AbstractAgent;

interface Recorded {
  order: string[];
  endArgs: Record<string, unknown>;
  pending: string[] | undefined;
}

async function run(
  events: BaseEvent[],
  extra: Partial<AgentSubscriber> = {},
): Promise<{ recorded: Recorded; messages: Message[] }> {
  const recorded: Recorded = { order: [], endArgs: {}, pending: undefined };
  const subscriber: AgentSubscriber = {
    onToolCallEndEvent: (params) => {
      recorded.order.push(`end:${params.event.toolCallId}`);
      recorded.endArgs[params.event.toolCallId] = {
        args: params.toolCallArgs,
        raw: params.toolCallArgsRaw,
        aborted: params.toolCallAborted,
      };
    },
    onNewToolCall: ({ toolCall }) => {
      recorded.order.push(`new:${toolCall.id}`);
    },
    onRunFinishedEvent: (params) => {
      if (params.outcome === "success") recorded.pending = params.pendingToolCallIds;
    },
    ...extra,
  };

  const events$ = new Subject<BaseEvent>();
  const result$ = defaultApplyEvents(input, events$, createAgent(), [subscriber]);
  const updates = firstValueFrom(result$.pipe(toArray()));
  for (const event of events) events$.next(event);
  events$.complete();
  const all = await updates;
  const messages = all.flatMap((u) => u.messages ?? []).slice(-50);
  const lastWithMessages = [...all].reverse().find((u) => u.messages !== undefined);
  return { recorded, messages: lastWithMessages?.messages ?? messages };
}

const start = (id: string, name = "lookup"): BaseEvent =>
  ({ type: EventType.TOOL_CALL_START, toolCallId: id, toolCallName: name }) as BaseEvent;
const args = (id: string, delta: string): BaseEvent =>
  ({ type: EventType.TOOL_CALL_ARGS, toolCallId: id, delta }) as BaseEvent;
const end = (id: string, metadata?: Record<string, unknown>): BaseEvent =>
  ({
    type: EventType.TOOL_CALL_END,
    toolCallId: id,
    ...(metadata ? { metadata } : {}),
  }) as BaseEvent;
const result = (id: string): BaseEvent =>
  ({
    type: EventType.TOOL_CALL_RESULT,
    messageId: `m-${id}`,
    toolCallId: id,
    content: "ok",
  }) as BaseEvent;
const runStarted = { type: EventType.RUN_STARTED, threadId: "t", runId: "r" } as BaseEvent;
const runFinished = {
  type: EventType.RUN_FINISHED,
  threadId: "t",
  runId: "r",
  outcome: { type: "success" },
} as BaseEvent;

const toolCallOf = (messages: Message[], id: string) =>
  messages
    .filter((m): m is AssistantMessage => m.role === "assistant")
    .flatMap((m) => m.toolCalls ?? [])
    .find((tc) => tc.id === id);

describe("aborted tool calls in defaultApplyEvents", () => {
  it("does not announce an aborted call as a new tool call", async () => {
    const { recorded } = await run([
      runStarted,
      start("root::inner"),
      args("root::inner", '{"city": "Pa'),
      end("root::inner", ABORTED),
      runFinished,
    ]);

    expect(recorded.order).toEqual(["end:root::inner"]);
  });

  it("tells the END subscriber the call is aborted and hands over the raw arguments", async () => {
    const { recorded } = await run([
      runStarted,
      start("root::inner"),
      args("root::inner", '{"city": "Pa'),
      end("root::inner", ABORTED),
      runFinished,
    ]);

    expect(recorded.endArgs["root::inner"]).toEqual({
      args: {},
      raw: '{"city": "Pa',
      aborted: true,
    });
  });

  it("keeps an aborted call out of the pending list when the run recovers", async () => {
    const { recorded } = await run([
      runStarted,
      start("root"),
      args("root", '{"q":"x"}'),
      end("root"),
      start("root::inner"),
      args("root::inner", '{"city": "Pa'),
      end("root::inner", ABORTED),
      result("root"),
      runFinished,
    ]);

    expect(recorded.pending).toEqual([]);
  });

  it("still lists an ordinary unanswered call as pending next to an aborted one", async () => {
    const { recorded } = await run([
      runStarted,
      start("ui_action"),
      args("ui_action", "{}"),
      end("ui_action"),
      start("root::inner"),
      args("root::inner", '{"city": "Pa'),
      end("root::inner", ABORTED),
      runFinished,
    ]);

    expect(recorded.pending).toEqual(["ui_action"]);
  });

  it("keeps the marker and the raw partial arguments on the stored tool call", async () => {
    const { messages } = await run([
      runStarted,
      start("root::inner"),
      args("root::inner", '{"city": "Pa'),
      end("root::inner", ABORTED),
      runFinished,
    ]);

    const call = toolCallOf(messages, "root::inner");
    expect(call?.function.arguments).toBe('{"city": "Pa');
    expect(call?.metadata).toEqual(ABORTED);
  });

  it("treats ordinary calls exactly as before", async () => {
    const { recorded } = await run([
      runStarted,
      start("a"),
      args("a", '{"x":1}'),
      end("a"),
      runFinished,
    ]);

    expect(recorded.order).toEqual(["end:a", "new:a"]);
    expect(recorded.endArgs["a"]).toEqual({ args: { x: 1 }, raw: '{"x":1}', aborted: false });
    expect(recorded.pending).toEqual(["a"]);
  });

  it("does not mistake a legitimate empty argument object for an aborted call", async () => {
    const { recorded } = await run([
      runStarted,
      start("a"),
      args("a", "{}"),
      end("a"),
      runFinished,
    ]);

    expect(recorded.endArgs["a"]).toEqual({ args: {}, raw: "{}", aborted: false });
    expect(recorded.order).toEqual(["end:a", "new:a"]);
  });

  it("only aborts the marked call among parallel siblings", async () => {
    const { recorded } = await run([
      runStarted,
      start("ok"),
      start("cut"),
      args("ok", '{"a":1}'),
      args("cut", '{"b":'),
      end("ok"),
      end("cut", ABORTED),
      runFinished,
    ]);

    expect(recorded.order).toEqual(["end:ok", "new:ok", "end:cut"]);
    expect(recorded.pending).toEqual(["ok"]);
  });

  it("does not treat other ag-ui metadata, or user metadata, as the marker", async () => {
    const { recorded } = await run([
      runStarted,
      start("a"),
      args("a", "{}"),
      end("a", { [AGUI_METADATA_KEY]: { usage: { output: 1 } }, aborted: true }),
      runFinished,
    ]);

    expect(recorded.endArgs["a"]).toMatchObject({ aborted: false });
    expect(recorded.order).toEqual(["end:a", "new:a"]);
  });
});

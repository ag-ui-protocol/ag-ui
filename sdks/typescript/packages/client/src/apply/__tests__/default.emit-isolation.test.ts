import { Subject, firstValueFrom } from "rxjs";
import { tap, toArray } from "rxjs/operators";
import { BaseEvent, EventType, Message, RunAgentInput } from "@ag-ui/core";
import { defaultApplyEvents } from "../default";
import { AbstractAgent } from "@/agent";
import { AgentStateMutation } from "@/agent/subscriber";

// Emitted updates are structural copies of only the messages that changed, not
// deep clones of the whole thread. These tests pin the two promises that makes:
// an emitted update never changes afterwards, and an unchanged message keeps
// its identity from one update to the next.

const createAgent = (messages: Message[] = [], state: unknown = {}) =>
  ({ messages: messages.map((m) => ({ ...m })), state }) as unknown as AbstractAgent;

const makeInput = (messages: Message[] = [], state: unknown = {}): RunAgentInput => ({
  messages,
  state,
  threadId: "thread-test",
  runId: "run-test",
  tools: [],
  context: [],
});

interface Collected {
  readonly updates: AgentStateMutation[];
  /** Each update serialized at the moment it was emitted. */
  readonly atEmit: string[];
}

async function emitAndCollect(
  initial: Message[],
  emit: (events$: Subject<BaseEvent>) => void,
  state: unknown = {},
): Promise<Collected> {
  const events$ = new Subject<BaseEvent>();
  const atEmit: string[] = [];
  const result$ = defaultApplyEvents(
    makeInput(initial, state),
    events$,
    createAgent(initial, state),
    [],
  ).pipe(tap((update) => atEmit.push(JSON.stringify(update))));
  const updatesPromise = firstValueFrom(result$.pipe(toArray()));
  emit(events$);
  events$.complete();
  return { updates: await updatesPromise, atEmit };
}

const history: Message[] = [
  { id: "user-1", role: "user", content: "first question" },
  { id: "assistant-1", role: "assistant", content: "first answer" },
  { id: "user-2", role: "user", content: "second question" },
];

describe("defaultApplyEvents emitted update isolation", () => {
  it("never changes an emitted update while text keeps streaming", async () => {
    const { updates, atEmit } = await emitAndCollect(history, (events$) => {
      events$.next({ type: EventType.TEXT_MESSAGE_START, messageId: "a2", role: "assistant" });
      for (let index = 0; index < 5; index += 1) {
        events$.next({
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: "a2",
          delta: `t${index} `,
        });
      }
      events$.next({ type: EventType.TEXT_MESSAGE_END, messageId: "a2" });
    });

    expect(updates.length).toBeGreaterThan(3);
    updates.forEach((update, index) => {
      expect(JSON.stringify(update)).toBe(atEmit[index]);
    });
    const last = updates[updates.length - 1]?.messages;
    expect(last?.find((m) => m.id === "a2")?.content).toBe("t0 t1 t2 t3 t4 ");
  });

  it("keeps unchanged messages' identity and gives the changed message a new object", async () => {
    const { updates } = await emitAndCollect(history, (events$) => {
      events$.next({ type: EventType.TEXT_MESSAGE_START, messageId: "a2", role: "assistant" });
      events$.next({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "a2", delta: "one" });
      events$.next({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "a2", delta: "two" });
    });

    const [, first, second] = updates.map((update) => update.messages ?? []);
    for (const id of ["user-1", "assistant-1", "user-2"]) {
      expect(second?.find((m) => m.id === id)).toBe(first?.find((m) => m.id === id));
    }
    const streamingBefore = first?.find((m) => m.id === "a2");
    const streamingAfter = second?.find((m) => m.id === "a2");
    expect(streamingAfter).not.toBe(streamingBefore);
    expect(streamingBefore?.content).toBe("one");
    expect(streamingAfter?.content).toBe("onetwo");
    expect(second).not.toBe(first);
  });

  it("never changes an emitted tool call while its arguments stream", async () => {
    const { updates, atEmit } = await emitAndCollect(history, (events$) => {
      events$.next({
        type: EventType.TOOL_CALL_START,
        toolCallId: "call-1",
        toolCallName: "search",
        parentMessageId: "a2",
      });
      events$.next({ type: EventType.TOOL_CALL_ARGS, toolCallId: "call-1", delta: '{"q":' });
      events$.next({ type: EventType.TOOL_CALL_ARGS, toolCallId: "call-1", delta: '"x"}' });
      events$.next({
        type: EventType.TOOL_CALL_START,
        toolCallId: "call-2",
        toolCallName: "fetch",
        parentMessageId: "a2",
      });
      events$.next({ type: EventType.TOOL_CALL_END, toolCallId: "call-1" });
    });

    updates.forEach((update, index) => {
      expect(JSON.stringify(update)).toBe(atEmit[index]);
    });
    const assistant = updates[updates.length - 1]?.messages?.find((m) => m.id === "a2") as {
      toolCalls?: { id: string; function: { arguments: string } }[];
    };
    expect(assistant.toolCalls?.map((call) => call.id)).toEqual(["call-1", "call-2"]);
    expect(assistant.toolCalls?.[0]?.function.arguments).toBe('{"q":"x"}');
  });

  it("keeps a tool result's position and leaves earlier updates intact", async () => {
    const { updates, atEmit } = await emitAndCollect(history, (events$) => {
      events$.next({
        type: EventType.TOOL_CALL_START,
        toolCallId: "call-1",
        toolCallName: "search",
        parentMessageId: "a2",
      });
      events$.next({ type: EventType.TOOL_CALL_END, toolCallId: "call-1" });
      events$.next({ type: EventType.TEXT_MESSAGE_START, messageId: "a3", role: "assistant" });
      events$.next({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "a3", delta: "after" });
      events$.next({
        type: EventType.TOOL_CALL_RESULT,
        toolCallId: "call-1",
        messageId: "result-1",
        content: "found",
      });
    });

    updates.forEach((update, index) => {
      expect(JSON.stringify(update)).toBe(atEmit[index]);
    });
    const ids = updates[updates.length - 1]?.messages?.map((m) => m.id);
    expect(ids).toEqual(["user-1", "assistant-1", "user-2", "a2", "result-1", "a3"]);
  });

  it("does not alias a MESSAGES_SNAPSHOT event, in either direction", async () => {
    const snapshotMessages: Message[] = [{ id: "s1", role: "assistant", content: "from snapshot" }];
    const { updates } = await emitAndCollect([], (events$) => {
      events$.next({ type: EventType.MESSAGES_SNAPSHOT, messages: snapshotMessages });
      events$.next({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "s1", delta: " more" });
    });

    // Streaming into the message must not write through to the caller's event.
    expect(snapshotMessages[0]?.content).toBe("from snapshot");
    // And editing the caller's event afterwards must not reach emitted updates.
    (snapshotMessages[0] as { content: string }).content = "changed by caller";
    expect(updates[0]?.messages?.[0]?.content).toBe("from snapshot");
    expect(updates[1]?.messages?.[0]?.content).toBe("from snapshot more");
  });

  it("does not alias a STATE_SNAPSHOT event and leaves earlier states intact", async () => {
    const snapshot = { items: [{ name: "a" }] };
    const { updates, atEmit } = await emitAndCollect([], (events$) => {
      events$.next({ type: EventType.STATE_SNAPSHOT, snapshot });
      events$.next({
        type: EventType.STATE_DELTA,
        delta: [{ op: "add", path: "/items/-", value: { name: "b" } }],
      });
    });

    snapshot.items.push({ name: "changed by caller" });
    updates.forEach((update, index) => {
      expect(JSON.stringify(update)).toBe(atEmit[index]);
    });
    expect(updates[0]?.state).toEqual({ items: [{ name: "a" }] });
    expect(updates[1]?.state).toEqual({ items: [{ name: "a" }, { name: "b" }] });
    expect(updates[1]?.state).not.toBe(updates[0]?.state);
  });
});

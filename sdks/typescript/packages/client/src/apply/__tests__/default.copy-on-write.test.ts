import { from, lastValueFrom } from "rxjs";
import { toArray } from "rxjs/operators";
import { BaseEvent, EventType, Message, RunAgentInput } from "@ag-ui/core";
import untruncateJson from "untruncate-json";
import { defaultApplyEvents } from "../default";
import { AbstractAgent } from "@/agent";
import type { AgentStateMutation, AgentSubscriber } from "@/agent/subscriber";

vi.mock("untruncate-json", () => ({
  default: vi.fn((buffer: string) => buffer),
}));

const untruncateJsonMock = vi.mocked(untruncateJson);

/**
 * Applying a streamed event costs O(delta), not O(transcript): `emitUpdates`
 * emits a new array that shares the untouched message objects, the touched
 * message is replaced by a copy, and `TOOL_CALL_ARGS` parses the partial
 * arguments once per event rather than once per subscriber.
 */
describe("defaultApplyEvents copy-on-write", () => {
  const transcript = (): Message[] => [
    { id: "u1", role: "user", content: "hello" },
    {
      id: "a1",
      role: "assistant",
      content: "earlier answer",
      toolCalls: [
        { id: "c0", type: "function", function: { name: "Bash", arguments: '{"command":"ls"}' } },
      ],
    },
    { id: "t1", role: "tool", toolCallId: "c0", content: "x".repeat(100_000) },
  ];

  const apply = (
    events: Partial<BaseEvent>[],
    messages: Message[],
    subscribers: AgentSubscriber[] = [],
  ): Promise<AgentStateMutation[]> => {
    const agent = { messages, state: {}, pendingInterrupts: [] } as unknown as AbstractAgent;
    const input: RunAgentInput = {
      threadId: "t",
      runId: "r",
      messages,
      state: {},
      tools: [],
      context: [],
    };
    return lastValueFrom(
      defaultApplyEvents(input, from(events as BaseEvent[]), agent, subscribers).pipe(toArray()),
    );
  };

  const messagesOf = (mutation: AgentStateMutation) => mutation.messages!;
  const textStart = { type: EventType.TEXT_MESSAGE_START, messageId: "a2", role: "assistant" };
  const text = (delta: string) => ({
    type: EventType.TEXT_MESSAGE_CONTENT,
    messageId: "a2",
    delta,
  });
  const toolEvents = [
    {
      type: EventType.TOOL_CALL_START,
      toolCallId: "c1",
      toolCallName: "Write",
      parentMessageId: "a1",
    },
    { type: EventType.TOOL_CALL_ARGS, toolCallId: "c1", delta: '{"file_path":' },
    { type: EventType.TOOL_CALL_ARGS, toolCallId: "c1", delta: '"/a.py"}' },
  ];

  beforeEach(() => {
    // runSubscribersWithMutation deep-clones and freezes the inputs it hands to
    // subscribers in dev/test only; run as production so the only clones left
    // are the ones the apply pipeline itself makes.
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VITEST_WORKER_ID", "");
    untruncateJsonMock.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("emits a new array per text delta that shares the untouched messages", async () => {
    const updates = await apply([textStart, text("a"), text("b"), text("c")], transcript());
    expect(updates).toHaveLength(4);
    const arrays = updates.map(messagesOf);
    for (let i = 1; i < arrays.length; i++) {
      expect(arrays[i]).not.toBe(arrays[i - 1]);
      expect(arrays[i][0]).toBe(arrays[0][0]);
      expect(arrays[i][1]).toBe(arrays[0][1]);
      expect(arrays[i][2]).toBe(arrays[0][2]);
    }
    const streamed = arrays.map((a) => a[3]);
    expect(streamed.map((m) => m.content)).toEqual(["", "a", "ab", "abc"]);
    expect(new Set(streamed).size).toBe(4);
  });

  it("never mutates an earlier emission", async () => {
    const updates = await apply([textStart, text("a"), text("b")], transcript());
    const [afterStart, afterA, afterB] = updates.map(messagesOf);
    expect(afterStart[3].content).toBe("");
    expect(afterA[3].content).toBe("a");
    expect(afterB[3].content).toBe("ab");
  });

  it("does not deep-clone the transcript per event", async () => {
    const clone = vi.spyOn(globalThis, "structuredClone");
    await apply([textStart, text("a"), text("b"), text("c")], transcript());
    const transcriptClones = clone.mock.calls.filter(
      ([value]) =>
        Array.isArray(value) ||
        (typeof value === "object" && value !== null && "messages" in (value as object)),
    );
    // exactly one: the pipeline's own copy of `agent.messages` at start
    expect(transcriptClones).toHaveLength(1);
  });

  it("accumulates tool-call arguments by replacing the message, its toolCalls and the call", async () => {
    const updates = await apply(toolEvents, transcript());
    expect(updates).toHaveLength(3);
    const arrays = updates.map(messagesOf);
    const assistant = arrays.map(
      (a) => a[1] as Message & { toolCalls: { function: { arguments: string } }[] },
    );
    expect(assistant.map((m) => m.toolCalls[1].function.arguments)).toEqual([
      "",
      '{"file_path":',
      '{"file_path":"/a.py"}',
    ]);
    expect(new Set(assistant).size).toBe(3);
    expect(new Set(assistant.map((m) => m.toolCalls)).size).toBe(3);
    expect(assistant[2].toolCalls[0]).toBe(assistant[0].toolCalls[0]);
    expect(arrays[2][0]).toBe(arrays[0][0]);
    expect(arrays[2][2]).toBe(arrays[0][2]);
  });

  it("parses the partial arguments once per event, only if a subscriber reads them", async () => {
    const received: unknown[] = [];
    const reader: AgentSubscriber = {
      onToolCallArgsEvent: ({ partialToolCallArgs }) => {
        received.push(partialToolCallArgs);
      },
    };
    const bystanders: AgentSubscriber[] = [
      { onTextMessageContentEvent: () => {} },
      { onRunStartedEvent: () => {} },
    ];

    await apply(toolEvents, transcript(), [reader, ...bystanders]);
    expect(untruncateJsonMock).toHaveBeenCalledTimes(2);
    expect(untruncateJsonMock.mock.calls.map(([b]) => b)).toEqual(["", '{"file_path":']);
    expect(received).toEqual(["", '{"file_path":']);

    untruncateJsonMock.mockClear();
    await apply(toolEvents, transcript(), bystanders);
    expect(untruncateJsonMock).not.toHaveBeenCalled();
  });

  it("folds event metadata onto a copy, not onto the shared object", async () => {
    const updates = await apply(
      [
        textStart,
        text("a"),
        { type: EventType.TEXT_MESSAGE_END, messageId: "a2", metadata: { usage: 7 } },
      ],
      transcript(),
    );
    const [, afterA, afterEnd] = updates.map(messagesOf);
    expect(afterEnd[3]).not.toBe(afterA[3]);
    expect(afterEnd[3].metadata).toEqual({ usage: 7 });
    expect(afterA[3].metadata).toBeUndefined();
  });

  it("keeps state a deep copy, detached from the event payload", async () => {
    const snapshot = { plan: { steps: ["one"] } };
    const updates = await apply([{ type: EventType.STATE_SNAPSHOT, snapshot }], transcript());
    expect(updates).toHaveLength(1);
    const emitted = updates[0].state as typeof snapshot;
    expect(emitted).toEqual(snapshot);
    expect(emitted).not.toBe(snapshot);
    emitted.plan.steps.push("two");
    expect(snapshot.plan.steps).toEqual(["one"]);
  });
});

import { AbstractAgent } from "../agent";
import { AgentSubscriber } from "../subscriber";
import { BaseEvent, EventType, Message, RunAgentInput } from "@ag-ui/core";
import { Observable, of } from "rxjs";
import { describe, it, expect } from "vitest";

// A tool result must sit directly after the assistant message that issued its
// call, and the stored history is what a run sends. The MESSAGES_SNAPSHOT merge
// keeps them together from now on, but a history can still hold a result away
// from its call: stored before that fix, or seeded through initialMessages. The
// run's input copy is re-paired; the agent keeps what it holds.

class CaptureAgent extends AbstractAgent {
  inputs: RunAgentInput[] = [];

  run(input: RunAgentInput): Observable<BaseEvent> {
    this.inputs.push(input);
    return of(
      { type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId },
      { type: EventType.RUN_FINISHED, threadId: input.threadId, runId: input.runId },
    ) as Observable<BaseEvent>;
  }

  protected connect(input: RunAgentInput): Observable<BaseEvent> {
    return this.run(input);
  }
}

const call = (id: string, ...callIds: string[]): Message => ({
  id,
  role: "assistant",
  toolCalls: callIds.map((callId) => ({
    id: callId,
    type: "function",
    function: { name: "lookup", arguments: "{}" },
  })),
});
const result = (id: string, toolCallId: string): Message => ({
  id,
  role: "tool",
  toolCallId,
  content: `result of ${toolCallId}`,
});
const text = (id: string, role: "user" | "assistant" = "assistant"): Message => ({
  id,
  role,
  content: `${id} text`,
});
const activity = (id: string): Message =>
  ({ id, role: "activity", activityType: "progress", content: {} }) as Message;

const ids = (messages: Message[]) => messages.map((message) => message.id);

// The order the snapshot merge used to leave behind.
const drifted = () => [text("u1", "user"), call("a1", "c1"), text("a1t"), result("t1", "c1")];

describe("run input keeps tool results with their calls", () => {
  it("re-pairs a drifted result in a run's input, and leaves the agent's history alone", async () => {
    const agent = new CaptureAgent({ initialMessages: drifted() });

    await agent.runAgent();

    expect(ids(agent.inputs[0].messages)).toEqual(["u1", "a1", "t1", "a1t"]);
    expect(ids(agent.messages)).toEqual(["u1", "a1", "a1t", "t1"]);
  });

  it("re-pairs a connect's input the same way", async () => {
    const agent = new CaptureAgent({ initialMessages: drifted() });

    await agent.connectAgent();

    expect(ids(agent.inputs[0].messages)).toEqual(["u1", "a1", "t1", "a1t"]);
  });

  it("keeps each turn's result with its turn when every turn reuses the call id", async () => {
    // A reload re-ids every result, so the merge appended them all at the end.
    const agent = new CaptureAgent({
      initialMessages: [
        text("u1", "user"),
        call("a1", "call_0"),
        text("a1t"),
        text("u2", "user"),
        call("a2", "call_0"),
        text("a2t"),
        result("t1", "call_0"),
        result("t2", "call_0"),
      ],
    });

    await agent.runAgent();

    expect(ids(agent.inputs[0].messages)).toEqual([
      "u1",
      "a1",
      "t1",
      "a1t",
      "u2",
      "a2",
      "t2",
      "a2t",
    ]);
  });

  it("sends a well-formed history unchanged", async () => {
    const history = [
      text("u1", "user"),
      call("a1", "c1", "c2"),
      result("t1", "c1"),
      result("t2", "c2"),
      text("a1t"),
    ];
    const agent = new CaptureAgent({ initialMessages: history });

    await agent.runAgent();

    expect(agent.inputs[0].messages).toEqual(history);
  });

  it("does not let an activity message keep a result from its call, and still drops it", async () => {
    const agent = new CaptureAgent({
      initialMessages: [call("a1", "c1"), activity("act"), result("t1", "c1")],
    });

    await agent.runAgent();

    expect(ids(agent.inputs[0].messages)).toEqual(["a1", "t1"]);
  });

  it("re-pairs a message list an onRunInitialized subscriber replaces", async () => {
    const agent = new CaptureAgent();
    const subscriber: AgentSubscriber = {
      onRunInitialized: () => ({ messages: drifted() }),
    };

    await agent.runAgent({}, subscriber);

    expect(ids(agent.inputs[0].messages)).toEqual(["u1", "a1", "t1", "a1t"]);
    expect(ids(agent.messages)).toEqual(["u1", "a1", "a1t", "t1"]);
  });
});

import { AbstractAgent } from "../agent";
import { AgentSubscriber } from "../subscriber";
import { BaseEvent, EventType, RunAgentInput } from "@ag-ui/core";
import { Observable, of } from "rxjs";
import { describe, it, expect, vi } from "vitest";

vi.mock("@/verify", () => ({
  verifyEvents: vi.fn(() => (source$: Observable<any>) => source$),
}));

vi.mock("@/chunks", () => ({
  transformChunks: vi.fn(() => (source$: Observable<any>) => source$),
}));

class TestAgent extends AbstractAgent {
  private eventsToEmit: BaseEvent[] = [];

  setEventsToEmit(events: BaseEvent[]) {
    this.eventsToEmit = events;
  }

  run(_input: RunAgentInput): Observable<BaseEvent> {
    return of(...this.eventsToEmit);
  }
}

const runStarted = { type: EventType.RUN_STARTED, threadId: "t", runId: "r" } as BaseEvent;
const toolCall = (id: string): BaseEvent[] => [
  { type: EventType.TOOL_CALL_START, toolCallId: id, toolCallName: "frontend_tool" } as BaseEvent,
  { type: EventType.TOOL_CALL_ARGS, toolCallId: id, delta: "{}" } as BaseEvent,
  { type: EventType.TOOL_CALL_END, toolCallId: id } as BaseEvent,
];
const toolResult = (id: string): BaseEvent =>
  ({
    type: EventType.TOOL_CALL_RESULT,
    messageId: `result-${id}`,
    toolCallId: id,
    content: "done",
  }) as BaseEvent;

/** Runs the stream and returns what onRunFinishedEvent saw. */
async function finishedParams(events: BaseEvent[]): Promise<any> {
  const agent = new TestAgent({ threadId: "t" });
  agent.setEventsToEmit(events);
  const onRunFinishedEvent = vi.fn();
  const subscriber: AgentSubscriber = { onRunFinishedEvent };
  await agent.runAgent({}, subscriber);
  expect(onRunFinishedEvent).toHaveBeenCalledTimes(1);
  return onRunFinishedEvent.mock.calls[0][0];
}

describe("RUN_FINISHED pendingToolCallIds", () => {
  it("is empty when the run left nothing unanswered", async () => {
    const params = await finishedParams([
      runStarted,
      { type: EventType.RUN_FINISHED, threadId: "t", runId: "r" } as BaseEvent,
    ]);
    expect(params.outcome).toBe("success");
    expect(params.pendingToolCallIds).toEqual([]);
  });

  it("derives the unanswered tool calls from the stream when the producer names none", async () => {
    const params = await finishedParams([
      runStarted,
      ...toolCall("tc-1"),
      ...toolCall("tc-2"),
      toolResult("tc-1"),
      ...toolCall("tc-3"),
      { type: EventType.RUN_FINISHED, threadId: "t", runId: "r" } as BaseEvent,
    ]);
    expect(params.pendingToolCallIds).toEqual(["tc-2", "tc-3"]);
  });

  it("derives the list under an explicit success outcome without the field", async () => {
    const params = await finishedParams([
      runStarted,
      ...toolCall("tc-1"),
      {
        type: EventType.RUN_FINISHED,
        threadId: "t",
        runId: "r",
        outcome: { type: "success" },
      } as BaseEvent,
    ]);
    expect(params.pendingToolCallIds).toEqual(["tc-1"]);
  });

  it("trusts the producer's list over the tally when it names one", async () => {
    const params = await finishedParams([
      runStarted,
      ...toolCall("tc-1"),
      ...toolCall("tc-2"),
      {
        type: EventType.RUN_FINISHED,
        threadId: "t",
        runId: "r",
        outcome: { type: "success", pendingToolCallIds: ["tc-2"] },
      } as BaseEvent,
    ]);
    expect(params.pendingToolCallIds).toEqual(["tc-2"]);
  });

  it("does not let a subscriber mutate the producer's list through aliasing", async () => {
    const named = ["tc-1"];
    const params = await finishedParams([
      runStarted,
      ...toolCall("tc-1"),
      {
        type: EventType.RUN_FINISHED,
        threadId: "t",
        runId: "r",
        outcome: { type: "success", pendingToolCallIds: named },
      } as BaseEvent,
    ]);
    params.pendingToolCallIds.push("tc-9");
    expect(named).toEqual(["tc-1"]);
  });

  it("is not reported on an interrupted run", async () => {
    const params = await finishedParams([
      runStarted,
      ...toolCall("tc-1"),
      {
        type: EventType.RUN_FINISHED,
        threadId: "t",
        runId: "r",
        outcome: { type: "interrupt", interrupts: [{ id: "i-1", reason: "approval" }] },
      } as BaseEvent,
    ]);
    expect(params.outcome).toBe("interrupt");
    expect(params).not.toHaveProperty("pendingToolCallIds");
  });

  it("starts a fresh tally for each run in one stream", async () => {
    const agent = new TestAgent({ threadId: "t" });
    agent.setEventsToEmit([
      { type: EventType.RUN_STARTED, threadId: "t", runId: "r-1" } as BaseEvent,
      ...toolCall("tc-1"),
      { type: EventType.RUN_FINISHED, threadId: "t", runId: "r-1" } as BaseEvent,
      { type: EventType.RUN_STARTED, threadId: "t", runId: "r-2" } as BaseEvent,
      ...toolCall("tc-2"),
      { type: EventType.RUN_FINISHED, threadId: "t", runId: "r-2" } as BaseEvent,
    ]);
    const onRunFinishedEvent = vi.fn();
    await agent.runAgent({}, { onRunFinishedEvent });
    expect(onRunFinishedEvent).toHaveBeenCalledTimes(2);
    expect(onRunFinishedEvent.mock.calls[0][0].pendingToolCallIds).toEqual(["tc-1"]);
    expect(onRunFinishedEvent.mock.calls[1][0].pendingToolCallIds).toEqual(["tc-2"]);
  });
});

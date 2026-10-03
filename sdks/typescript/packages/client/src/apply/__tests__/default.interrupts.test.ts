import { AbstractAgent } from "../../agent/agent";
import {
  BaseEvent,
  EventType,
  RunAgentInput,
  RunFinishedEvent,
  RunStartedEvent,
} from "@ag-ui/core";
import { Observable, of } from "rxjs";

class TestAgent extends AbstractAgent {
  private events: BaseEvent[] = [];

  setEvents(events: BaseEvent[]) {
    this.events = events;
  }

  run(_input: RunAgentInput): Observable<BaseEvent> {
    return of(...this.events);
  }
}

const runStarted = (runId: string): RunStartedEvent =>
  ({ type: EventType.RUN_STARTED, threadId: "t", runId }) as RunStartedEvent;

const interruptFinished = (runId: string, interruptId: string): RunFinishedEvent =>
  ({
    type: EventType.RUN_FINISHED,
    threadId: "t",
    runId,
    outcome: { type: "interrupt", interrupts: [{ id: interruptId, reason: "tool_call" }] },
  }) as unknown as RunFinishedEvent;

const successFinished = (runId: string): RunFinishedEvent =>
  ({ type: EventType.RUN_FINISHED, threadId: "t", runId, result: "ok" }) as RunFinishedEvent;

describe("RUN_FINISHED and pendingInterrupts", () => {
  it("keeps the interrupt pending when the same stream finishes a later run successfully", async () => {
    // Reporter's sequence (issue #2437, part 3): the server emits an interrupt
    // outcome and then, without the client ever resuming, starts a second run
    // in the same stream and finishes it plainly. The interrupt gate must hold.
    const agent = new TestAgent({ threadId: "t", initialMessages: [] });
    agent.setEvents([
      runStarted("run-1"),
      interruptFinished("run-1", "int-1"),
      runStarted("run-2"),
      successFinished("run-2"),
    ]);

    await agent.runAgent({ runId: "run-1" });

    expect(agent.pendingInterrupts.map((i) => i.id)).toEqual(["int-1"]);

    // And the gate in onInitialize is still armed for the next client run.
    await expect(agent.runAgent({ runId: "run-3" })).rejects.toThrow(
      /pending interrupt\(s\) not addressed by resume: int-1/,
    );
  });

  it("clears the interrupt when the run that resumed it finishes successfully", async () => {
    const agent = new TestAgent({ threadId: "t", initialMessages: [] });
    agent.setEvents([runStarted("run-1"), interruptFinished("run-1", "int-1")]);
    await agent.runAgent({ runId: "run-1" });
    expect(agent.pendingInterrupts.map((i) => i.id)).toEqual(["int-1"]);

    agent.setEvents([runStarted("run-2"), successFinished("run-2")]);
    await agent.runAgent({
      runId: "run-2",
      resume: [{ interruptId: "int-1", status: "resolved" }],
    });

    expect(agent.pendingInterrupts).toEqual([]);

    // Gate released: a plain run is allowed again.
    agent.setEvents([runStarted("run-3"), successFinished("run-3")]);
    await expect(agent.runAgent({ runId: "run-3" })).resolves.toBeDefined();
  });

  it("clears the interrupt when the resume entry cancelled it", async () => {
    const agent = new TestAgent({ threadId: "t", initialMessages: [] });
    agent.setEvents([runStarted("run-1"), interruptFinished("run-1", "int-1")]);
    await agent.runAgent({ runId: "run-1" });

    agent.setEvents([runStarted("run-2"), successFinished("run-2")]);
    await agent.runAgent({
      runId: "run-2",
      resume: [{ interruptId: "int-1", status: "cancelled" }],
    });

    expect(agent.pendingInterrupts).toEqual([]);
  });
});

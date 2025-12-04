import { AbstractAgent } from "../agent";
import { BaseEvent, EventType, RunAgentInput } from "@ag-ui/core";
import { Observable } from "rxjs";

class DeferredThreadIdAgent extends AbstractAgent {
  public observed: { agentThreadId: string; inputThreadId?: string } | undefined;

  constructor() {
    super({ deferThreadId: true });
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      this.observed = {
        agentThreadId: this.threadId,
        inputThreadId: input.threadId,
      };

      const bound = this.resolveThreadIdOnce("ctx-deferred");

      subscriber.next({
        type: EventType.RUN_STARTED,
        threadId: bound,
        runId: input.runId,
      } as BaseEvent);

      subscriber.next({
        type: EventType.RUN_FINISHED,
        threadId: bound,
        runId: input.runId,
      } as BaseEvent);

      subscriber.complete();
    });
  }
}

describe("AbstractAgent deferThreadId", () => {
  it("does not pre-generate a threadId when deferral is enabled", async () => {
    const agent = new DeferredThreadIdAgent();

    expect(agent.threadId).toBe("");

    await agent.runAgent({});

    expect(agent.observed?.agentThreadId).toBe("");
    expect(agent.observed?.inputThreadId).toBe("");
    expect(agent.threadId).toBe("ctx-deferred");
  });

  it("keeps existing behavior for non-deferred agents by pre-generating threadId", async () => {
    class EagerThreadIdAgent extends AbstractAgent {
      public observed?: { agentThreadId: string; inputThreadId?: string };

      run(input: RunAgentInput): Observable<BaseEvent> {
        this.observed = { agentThreadId: this.threadId, inputThreadId: input.threadId };
        return new Observable<BaseEvent>((subscriber) => {
          subscriber.next({
            type: EventType.RUN_STARTED,
            threadId: input.threadId,
            runId: input.runId,
          } as BaseEvent);
          subscriber.complete();
        });
      }
    }

    const agent = new EagerThreadIdAgent();
    const initialThreadId = agent.threadId;

    await agent.runAgent({});

    expect(initialThreadId).toBeTruthy();
    expect(agent.observed?.agentThreadId).toBe(initialThreadId);
    expect(agent.observed?.inputThreadId).toBe(initialThreadId);
  });
});

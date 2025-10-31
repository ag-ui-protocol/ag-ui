import { AbstractAgent } from "@/agent";
import { Middleware } from "@/middleware";
import { BaseEvent, EventType, RunAgentInput } from "@ag-ui/core";
import { Observable } from "rxjs";

describe("Middleware", () => {
  class TestAgent extends AbstractAgent {
    run(input: RunAgentInput): Observable<BaseEvent> {
      return new Observable<BaseEvent>((subscriber) => {
        subscriber.next({
          type: EventType.RUN_STARTED,
          threadId: input.threadId,
          runId: input.runId,
        });

        subscriber.next({
          type: EventType.RUN_FINISHED,
          threadId: input.threadId,
          runId: input.runId,
          result: { success: true },
        });

        subscriber.complete();
      });
    }
  }

  class TestMiddleware extends Middleware {
    run(input: RunAgentInput, next: AbstractAgent): Observable<BaseEvent> {
      return new Observable<BaseEvent>((subscriber) => {
        subscriber.next({
          type: EventType.RUN_STARTED,
          threadId: input.threadId,
          runId: input.runId,
          metadata: { middleware: true },
        });

        next.run(input).subscribe({
          next: (event) => subscriber.next(event),
          complete: () => subscriber.complete(),
        });
      });
    }
  }

  const input: RunAgentInput = {
    threadId: "test-thread",
    runId: "test-run",
    tools: [],
    context: [],
    forwardedProps: {},
    state: {},
    messages: [],
  };

  it("should allow middleware to modify the event stream", async () => {
    const agent = new TestAgent();
    const middleware = new TestMiddleware();

    const events: BaseEvent[] = [];
    await new Promise<void>((resolve) => {
      middleware.run(input, agent).subscribe({
        next: (event) => events.push(event),
        complete: () => resolve(),
      });
    });

    expect(events.length).toBe(3);
    expect(events[0].type).toBe(EventType.RUN_STARTED);
    expect((events[0] as any).metadata).toEqual({ middleware: true });
    expect(events[1].type).toBe(EventType.RUN_STARTED);
    expect(events[2].type).toBe(EventType.RUN_FINISHED);
    expect((events[2] as any).result).toEqual({ success: true });
  });
});

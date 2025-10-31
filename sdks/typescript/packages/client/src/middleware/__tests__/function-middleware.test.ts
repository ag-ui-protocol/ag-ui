import { AbstractAgent } from "@/agent";
import { FunctionMiddleware, MiddlewareFunction } from "@/middleware";
import { BaseEvent, EventType, RunAgentInput } from "@ag-ui/core";
import { Observable } from "rxjs";

describe("FunctionMiddleware", () => {
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
        });

        subscriber.complete();
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

  it("should allow function-based middleware to intercept events", async () => {
    const agent = new TestAgent();

    const middlewareFn: MiddlewareFunction = (middlewareInput, next) => {
      return new Observable<BaseEvent>((subscriber) => {
        subscriber.next({
          type: EventType.RUN_STARTED,
          threadId: middlewareInput.threadId,
          runId: middlewareInput.runId,
        });

        next.run(middlewareInput).subscribe({
          next: (event) => {
            if (event.type === EventType.RUN_FINISHED) {
              subscriber.next({
                ...event,
                result: { success: true },
              });
            } else {
              subscriber.next(event);
            }
          },
          complete: () => subscriber.complete(),
        });
      });
    };

    const middleware = new FunctionMiddleware(middlewareFn);

    const events: BaseEvent[] = [];
    await new Promise<void>((resolve) => {
      middleware.run(input, agent).subscribe({
        next: (event) => events.push(event),
        complete: () => resolve(),
      });
    });

    expect(events.length).toBe(2);
    expect(events[0].type).toBe(EventType.RUN_STARTED);
    expect(events[1].type).toBe(EventType.RUN_FINISHED);
    expect((events[1] as any).result).toEqual({ success: true });
  });
});

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
        const subscription = next.run(input).subscribe({
          next: (event) => {
            if (event.type === EventType.RUN_STARTED) {
              subscriber.next({
                ...event,
                metadata: { ...(event as any).metadata, middleware: true },
              });
              return;
            }

            subscriber.next(event);
          },
          error: (error) => subscriber.error(error),
          complete: () => subscriber.complete(),
        });

        return () => subscription.unsubscribe();
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

    expect(events.length).toBe(2);
    expect(events[0].type).toBe(EventType.RUN_STARTED);
    expect((events[0] as any).metadata).toEqual({ middleware: true });
    expect(events[1].type).toBe(EventType.RUN_FINISHED);
    expect((events[1] as any).result).toEqual({ success: true });
  });
});

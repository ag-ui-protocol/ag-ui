import { AbstractAgent } from "@/agent";
import { Middleware } from "@/middleware";
import {
  BaseEvent,
  EventType,
  RunAgentInput,
  TextMessageChunkEvent,
  RunFinishedEvent,
  RunStartedEvent,
} from "@ag-ui/core";
import { Observable } from "rxjs";

describe("Middleware live events", () => {
  class LiveEventAgent extends AbstractAgent {
    run(input: RunAgentInput): Observable<BaseEvent> {
      return new Observable<BaseEvent>((subscriber) => {
        subscriber.next({
          type: EventType.RUN_STARTED,
          threadId: input.threadId,
          runId: input.runId,
        } as RunStartedEvent);

        subscriber.next({
          type: EventType.TEXT_MESSAGE_CHUNK,
          messageId: "message-1",
          role: "assistant",
          delta: "Hello",
        } as TextMessageChunkEvent);

        subscriber.next({
          type: EventType.RUN_FINISHED,
          threadId: input.threadId,
          runId: input.runId,
          result: { success: true },
        } as RunFinishedEvent);

        subscriber.complete();
      });
    }
  }

  class CustomMiddleware extends Middleware {
    run(input: RunAgentInput, next: AbstractAgent): Observable<BaseEvent> {
      return new Observable<BaseEvent>((subscriber) => {
        const subscription = next.run(input).subscribe({
          next: (event) => {
            if (event.type === EventType.RUN_STARTED) {
              const started = event as RunStartedEvent;
              subscriber.next({
                ...started,
                metadata: {
                  ...(started.metadata ?? {}),
                  custom: true,
                },
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

  it("should allow middleware to emit events before the agent", async () => {
    const agent = new LiveEventAgent();
    const middleware = new CustomMiddleware();

    const events: BaseEvent[] = [];
    await new Promise<void>((resolve) => {
      middleware.run(input, agent).subscribe({
        next: (event) => events.push(event),
        complete: () => resolve(),
      });
    });

    expect(events.length).toBe(3);
    expect(events[0].type).toBe(EventType.RUN_STARTED);
    expect((events[0] as RunStartedEvent).metadata).toEqual({ custom: true });
    expect(events[1].type).toBe(EventType.TEXT_MESSAGE_CHUNK);
    expect(events[2].type).toBe(EventType.RUN_FINISHED);
  });
});

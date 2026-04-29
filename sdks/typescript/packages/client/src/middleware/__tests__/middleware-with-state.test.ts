import { AbstractAgent } from "@/agent";
import { Middleware } from "@/middleware";
import {
  BaseEvent,
  EventType,
  RunAgentInput,
  RunFinishedEvent,
  TextMessageChunkEvent,
} from "@ag-ui/core";
import { Observable } from "rxjs";

describe("Middleware runNextWithState", () => {
  class StatefulAgent extends AbstractAgent {
    run(input: RunAgentInput): Observable<BaseEvent> {
      return new Observable<BaseEvent>((subscriber) => {
        subscriber.next({
          type: EventType.RUN_STARTED,
          threadId: input.threadId,
          runId: input.runId,
        });

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

  class StateTrackingMiddleware extends Middleware {
    run(input: RunAgentInput, next: AbstractAgent): Observable<BaseEvent> {
      return this.runNextWithState(input, next).pipe((source) => {
        return new Observable<BaseEvent>((subscriber) => {
          source.subscribe({
            next: ({ event }) => subscriber.next(event),
            complete: () => subscriber.complete(),
          });
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

  it("should capture state changes after each event", async () => {
    const agent = new StatefulAgent();
    const middleware = new StateTrackingMiddleware();

    const events: BaseEvent[] = [];
    await new Promise<void>((resolve) => {
      middleware.run(input, agent).subscribe({
        next: (event) => events.push(event),
        complete: () => resolve(),
      });
    });

    expect(events.length).toBe(5);
    expect(events[0].type).toBe(EventType.RUN_STARTED);
    expect(events[1].type).toBe(EventType.TEXT_MESSAGE_START);
    expect(events[2].type).toBe(EventType.TEXT_MESSAGE_CONTENT);
    expect(events[3].type).toBe(EventType.TEXT_MESSAGE_END);
    expect(events[4].type).toBe(EventType.RUN_FINISHED);
  });
});

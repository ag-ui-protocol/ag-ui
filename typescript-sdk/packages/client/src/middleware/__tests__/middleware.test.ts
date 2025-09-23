import { AbstractAgent } from "@/agent";
import { Middleware } from "@/middleware";
import { BaseEvent, EventType, RunAgentInput, TextMessageChunkEvent } from "@ag-ui/core";
import { Observable, of } from "rxjs";
import { map, tap } from "rxjs/operators";

describe("Middleware", () => {
  class SimpleAgent extends AbstractAgent {
    public run(input: RunAgentInput): Observable<BaseEvent> {
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

  class TextInjectionMiddleware extends Middleware {
    constructor(private text: string) {
      super();
    }

    public run(input: RunAgentInput, next: AbstractAgent): Observable<BaseEvent> {

      return new Observable<BaseEvent>((subscriber) => {
        const subscription = next.run(input).subscribe({
          next: (event) => {
            subscriber.next(event);

            // Inject text message chunk after RUN_STARTED
            if (event.type === EventType.RUN_STARTED) {
              const textEvent: TextMessageChunkEvent = {
                type: EventType.TEXT_MESSAGE_CHUNK,
                role: "assistant",
                messageId: "test-message-id",
                delta: this.text,
              };
              subscriber.next(textEvent);
            }
          },
          error: (err) => subscriber.error(err),
          complete: () => subscriber.complete(),
        });

        return () => subscription.unsubscribe();
      });
    }
  }

  class EventCounterMiddleware extends Middleware {
    public eventCount = 0;
    public eventTypes: EventType[] = [];

    public run(input: RunAgentInput, next: AbstractAgent): Observable<BaseEvent> {

      return next.run(input).pipe(
        tap((event) => {
          this.eventCount++;
          this.eventTypes.push(event.type);
        })
      );
    }
  }

  class EventTransformMiddleware extends Middleware {
    public run(input: RunAgentInput, next: AbstractAgent): Observable<BaseEvent> {

      return next.run(input).pipe(
        map((event) => {
          // Add metadata to all events
          return {
            ...event,
            metadata: { transformed: true },
          } as BaseEvent;
        })
      );
    }
  }

  it("should inject text message chunk between RUN_STARTED and RUN_FINISHED", async () => {
    const agent = new SimpleAgent();
    const middleware = new TextInjectionMiddleware("Hello from middleware!");

    agent.use(middleware);

    const events: BaseEvent[] = [];
    const result = await agent.runAgent({}, (params) => {
      if (params.onEvent) {
        params.onEvent({ event: params as any, messages: [], state: {}, agent, input: {} as any });
      }
    });

    // Collect events through the pipeline
    const input: RunAgentInput = {
      threadId: "test-thread",
      runId: "test-run",
      tools: [],
      context: [],
      forwardedProps: {},
      state: {},
      messages: [],
    };

    const subscription = agent["middlewares"][0].run(input, agent).subscribe({
      next: (event) => events.push(event),
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(events.length).toBe(3);
    expect(events[0].type).toBe(EventType.RUN_STARTED);
    expect(events[1].type).toBe(EventType.TEXT_MESSAGE_CHUNK);
    expect((events[1] as TextMessageChunkEvent).delta).toBe("Hello from middleware!");
    expect(events[2].type).toBe(EventType.RUN_FINISHED);
  });

  it("should chain multiple middleware correctly", async () => {
    const agent = new SimpleAgent();
    const textMiddleware1 = new TextInjectionMiddleware("First");
    const textMiddleware2 = new TextInjectionMiddleware("Second");

    agent.use(textMiddleware1, textMiddleware2);

    const events: BaseEvent[] = [];
    const input: RunAgentInput = {
      threadId: "test-thread",
      runId: "test-run",
      tools: [],
      context: [],
      forwardedProps: {},
      state: {},
      messages: [],
    };

    // Build the chain as the agent does
    const chainedAgent = agent["middlewares"].reduceRight(
      (nextAgent: AbstractAgent, middleware) => ({
        run: (i: RunAgentInput) => middleware.run(i, nextAgent),
      } as AbstractAgent),
      agent
    );

    const subscription = chainedAgent.run(input).subscribe({
      next: (event) => events.push(event),
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(events.length).toBe(4);
    expect(events[0].type).toBe(EventType.RUN_STARTED);
    expect(events[1].type).toBe(EventType.TEXT_MESSAGE_CHUNK);
    expect((events[1] as TextMessageChunkEvent).delta).toBe("First");
    expect(events[2].type).toBe(EventType.TEXT_MESSAGE_CHUNK);
    expect((events[2] as TextMessageChunkEvent).delta).toBe("Second");
    expect(events[3].type).toBe(EventType.RUN_FINISHED);
  });

  it("should allow middleware to observe events", async () => {
    const agent = new SimpleAgent();
    const counterMiddleware = new EventCounterMiddleware();

    agent.use(counterMiddleware);

    const input: RunAgentInput = {
      threadId: "test-thread",
      runId: "test-run",
      tools: [],
      context: [],
      forwardedProps: {},
      state: {},
      messages: [],
    };

    const events: BaseEvent[] = [];
    const subscription = counterMiddleware.run(input, agent).subscribe({
      next: (event) => events.push(event),
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(counterMiddleware.eventCount).toBe(2);
    expect(counterMiddleware.eventTypes).toEqual([
      EventType.RUN_STARTED,
      EventType.RUN_FINISHED,
    ]);
  });

  it("should allow middleware to transform events", async () => {
    const agent = new SimpleAgent();
    const transformMiddleware = new EventTransformMiddleware();

    agent.use(transformMiddleware);

    const input: RunAgentInput = {
      threadId: "test-thread",
      runId: "test-run",
      tools: [],
      context: [],
      forwardedProps: {},
      state: {},
      messages: [],
    };

    const events: BaseEvent[] = [];
    const subscription = transformMiddleware.run(input, agent).subscribe({
      next: (event) => events.push(event),
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(events.length).toBe(2);
    expect((events[0] as any).metadata?.transformed).toBe(true);
    expect((events[1] as any).metadata?.transformed).toBe(true);
  });


  it("should work with 2 middleware and 1 actual agent in a chain", async () => {
    // The actual agent that sends RUN_STARTED and RUN_FINISHED
    const agent = new SimpleAgent();

    // First middleware: modifies any text message chunks to have fixed text
    class TextModifierMiddleware extends Middleware {
      constructor(private replacementText: string) {
        super();
      }

      public run(input: RunAgentInput, next: AbstractAgent): Observable<BaseEvent> {

        return next.run(input).pipe(
          map((event) => {
            // If it's a text message chunk, replace the delta
            if (event.type === EventType.TEXT_MESSAGE_CHUNK) {
              const textEvent = event as TextMessageChunkEvent;
              return {
                ...textEvent,
                delta: this.replacementText,
              } as TextMessageChunkEvent;
            }
            // Pass through other events unchanged
            return event;
          })
        );
      }
    }

    // Second middleware: injects a text message chunk after RUN_STARTED
    const textInjectionMiddleware = new TextInjectionMiddleware("Original text from middleware");

    const textModifierMiddleware = new TextModifierMiddleware("Modified text!");

    // Add middleware in order: modifier first (outermost), then injection (innermost)
    // This way: modifier -> injection -> agent
    // And events flow back: agent -> injection (adds text) -> modifier (modifies text)
    agent.use(textModifierMiddleware, textInjectionMiddleware);

    const input: RunAgentInput = {
      threadId: "test-thread",
      runId: "test-run",
      tools: [],
      context: [],
      forwardedProps: {},
      state: {},
      messages: [],
    };

    // Build the chain as the agent does internally
    const chainedAgent = agent["middlewares"].reduceRight(
      (nextAgent: AbstractAgent, middleware) => ({
        run: (i: RunAgentInput) => middleware.run(i, nextAgent),
      } as AbstractAgent),
      agent
    );

    const events: BaseEvent[] = [];
    await new Promise<void>((resolve) => {
      chainedAgent.run(input).subscribe({
        next: (event) => events.push(event),
        complete: () => resolve(),
      });
    });

    // Verify the event sequence
    expect(events.length).toBe(3);

    // First event: RUN_STARTED from the agent
    expect(events[0].type).toBe(EventType.RUN_STARTED);

    // Second event: TEXT_MESSAGE_CHUNK injected by first middleware,
    // but with text modified by second middleware
    expect(events[1].type).toBe(EventType.TEXT_MESSAGE_CHUNK);
    expect((events[1] as TextMessageChunkEvent).delta).toBe("Modified text!");

    // Third event: RUN_FINISHED from the agent
    expect(events[2].type).toBe(EventType.RUN_FINISHED);
  });
});
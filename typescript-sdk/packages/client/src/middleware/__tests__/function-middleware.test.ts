import { AbstractAgent } from "@/agent";
import { MiddlewareFunction } from "@/middleware";
import { BaseEvent, EventType, RunAgentInput, TextMessageChunkEvent } from "@ag-ui/core";
import { Observable } from "rxjs";
import { map, tap } from "rxjs/operators";

describe("Function-based Middleware", () => {
  class SimpleAgent extends AbstractAgent {
    public run(input: RunAgentInput): Observable<BaseEvent> {
      return new Observable<BaseEvent>((subscriber) => {
        subscriber.next({
          type: EventType.RUN_STARTED,
          threadId: input.threadId,
          runId: input.runId,
        });

        subscriber.next({
          type: EventType.TEXT_MESSAGE_CHUNK,
          role: "assistant",
          messageId: "msg-1",
          delta: "Hello from agent",
        } as TextMessageChunkEvent);

        subscriber.next({
          type: EventType.RUN_FINISHED,
          threadId: input.threadId,
          runId: input.runId,
        });

        subscriber.complete();
      });
    }
  }

  it("should accept a function as middleware", async () => {
    const agent = new SimpleAgent();

    // Define a simple function middleware that adds a prefix to text chunks
    const prefixMiddleware: MiddlewareFunction = (input, next) => {
      return next.run(input).pipe(
        map((event) => {
          if (event.type === EventType.TEXT_MESSAGE_CHUNK) {
            const textEvent = event as TextMessageChunkEvent;
            return {
              ...textEvent,
              delta: `[PREFIX] ${textEvent.delta}`,
            } as TextMessageChunkEvent;
          }
          return event;
        })
      );
    };

    agent.use(prefixMiddleware);

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
    const chainedAgent = agent["middlewares"].reduceRight(
      (nextAgent: AbstractAgent, middleware) => ({
        run: (i: RunAgentInput) => middleware.run(i, nextAgent),
      } as AbstractAgent),
      agent
    );

    await new Promise<void>((resolve) => {
      chainedAgent.run(input).subscribe({
        next: (event) => events.push(event),
        complete: () => resolve(),
      });
    });

    expect(events.length).toBe(3);
    expect(events[0].type).toBe(EventType.RUN_STARTED);

    const textEvent = events[1] as TextMessageChunkEvent;
    expect(textEvent.type).toBe(EventType.TEXT_MESSAGE_CHUNK);
    expect(textEvent.delta).toBe("[PREFIX] Hello from agent");

    expect(events[2].type).toBe(EventType.RUN_FINISHED);
  });

  it("should chain multiple function middlewares", async () => {
    const agent = new SimpleAgent();

    // First middleware adds a prefix
    const prefixMiddleware: MiddlewareFunction = (input, next) => {
      return next.run(input).pipe(
        map((event) => {
          if (event.type === EventType.TEXT_MESSAGE_CHUNK) {
            const textEvent = event as TextMessageChunkEvent;
            return {
              ...textEvent,
              delta: `[PREFIX] ${textEvent.delta}`,
            } as TextMessageChunkEvent;
          }
          return event;
        })
      );
    };

    // Second middleware adds a suffix
    const suffixMiddleware: MiddlewareFunction = (input, next) => {
      return next.run(input).pipe(
        map((event) => {
          if (event.type === EventType.TEXT_MESSAGE_CHUNK) {
            const textEvent = event as TextMessageChunkEvent;
            return {
              ...textEvent,
              delta: `${textEvent.delta} [SUFFIX]`,
            } as TextMessageChunkEvent;
          }
          return event;
        })
      );
    };

    agent.use(prefixMiddleware, suffixMiddleware);

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
    const chainedAgent = agent["middlewares"].reduceRight(
      (nextAgent: AbstractAgent, middleware) => ({
        run: (i: RunAgentInput) => middleware.run(i, nextAgent),
      } as AbstractAgent),
      agent
    );

    await new Promise<void>((resolve) => {
      chainedAgent.run(input).subscribe({
        next: (event) => events.push(event),
        complete: () => resolve(),
      });
    });

    const textEvent = events[1] as TextMessageChunkEvent;
    expect(textEvent.delta).toBe("[PREFIX] Hello from agent [SUFFIX]");
  });

  it("should mix function and class middleware", async () => {
    const agent = new SimpleAgent();

    // Function middleware that adds a counter
    let counter = 0;
    const countingMiddleware: MiddlewareFunction = (input, next) => {
      return next.run(input).pipe(
        tap(() => counter++)
      );
    };

    // Class middleware that adds a prefix
    class PrefixMiddleware extends Middleware {
      constructor(private prefix: string) {
        super();
      }

      run(input: RunAgentInput, next: AbstractAgent): Observable<BaseEvent> {
        return next.run(input).pipe(
          map((event) => {
            if (event.type === EventType.TEXT_MESSAGE_CHUNK) {
              const textEvent = event as TextMessageChunkEvent;
              return {
                ...textEvent,
                delta: `${this.prefix} ${textEvent.delta}`,
              } as TextMessageChunkEvent;
            }
            return event;
          })
        );
      }
    }

    const prefixMiddleware = new PrefixMiddleware("[CLASS]");

    // Mix both types
    agent.use(countingMiddleware, prefixMiddleware);

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
    const chainedAgent = agent["middlewares"].reduceRight(
      (nextAgent: AbstractAgent, middleware) => ({
        run: (i: RunAgentInput) => middleware.run(i, nextAgent),
      } as AbstractAgent),
      agent
    );

    await new Promise<void>((resolve) => {
      chainedAgent.run(input).subscribe({
        next: (event) => events.push(event),
        complete: () => resolve(),
      });
    });

    // Check that counting middleware ran
    expect(counter).toBe(3); // 3 events total

    // Check that class middleware transformed the text
    const textEvent = events[1] as TextMessageChunkEvent;
    expect(textEvent.delta).toBe("[CLASS] Hello from agent");
  });

  it("should handle event transformation in function middleware", async () => {
    const agent = new SimpleAgent();

    // Function middleware that counts events
    let eventCount = 0;
    const countingMiddleware: MiddlewareFunction = (input, next) => {
      return next.run(input).pipe(
        tap(() => {
          eventCount++;
        })
      );
    };

    // Function middleware that filters events
    const filterMiddleware: MiddlewareFunction = (input, next) => {
      return next.run(input).pipe(
        map((event) => {
          // Add metadata to all events
          return {
            ...event,
            metadata: { processed: true }
          } as BaseEvent & { metadata: { processed: boolean } };
        })
      );
    };

    agent.use(countingMiddleware, filterMiddleware);

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

    const chainedAgent = agent["middlewares"].reduceRight(
      (nextAgent: AbstractAgent, middleware) => ({
        run: (i: RunAgentInput) => middleware.run(i, nextAgent),
      } as AbstractAgent),
      agent
    );

    await new Promise<void>((resolve) => {
      chainedAgent.run(input).subscribe({
        next: (event) => events.push(event),
        complete: () => resolve(),
      });
    });

    // Check that counting middleware counted all events
    expect(eventCount).toBe(3);

    // Check that filter middleware added metadata
    expect(events.length).toBe(3);
    events.forEach(event => {
      expect((event as any).metadata?.processed).toBe(true);
    });
  });
});

// Import Middleware here to avoid circular dependency issues
import { Middleware } from "@/middleware";
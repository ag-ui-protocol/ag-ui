import { AbstractAgent } from "@/agent";
import { Middleware } from "@/middleware";
import { BaseEvent, EventType, RunAgentInput, TextMessageChunkEvent } from "@ag-ui/core";
import { Observable, interval } from "rxjs";
import { map, take, concatMap } from "rxjs/operators";

describe("Middleware Live Event Streaming", () => {
  class StreamingAgent extends AbstractAgent {
    public run(input: RunAgentInput): Observable<BaseEvent> {
      return new Observable<BaseEvent>((subscriber) => {
        // Emit RUN_STARTED immediately
        subscriber.next({
          type: EventType.RUN_STARTED,
          threadId: input.threadId,
          runId: input.runId,
        });

        // Simulate streaming text chunks over time
        const streamingText = ["Hello", " ", "world", "!"];
        let index = 0;

        const intervalSub = interval(50).pipe(take(streamingText.length)).subscribe({
          next: () => {
            const chunk: TextMessageChunkEvent = {
              type: EventType.TEXT_MESSAGE_CHUNK,
              role: "assistant",
              messageId: "streaming-message",
              delta: streamingText[index++],
            };
            subscriber.next(chunk);
          },
          complete: () => {
            // Emit RUN_FINISHED after all chunks
            subscriber.next({
              type: EventType.RUN_FINISHED,
              threadId: input.threadId,
              runId: input.runId,
            });
            subscriber.complete();
          }
        });

        return () => intervalSub.unsubscribe();
      });
    }
  }

  class TimestampMiddleware extends Middleware {
    public timestamps: Map<EventType, number> = new Map();

    public run(input: RunAgentInput, next: AbstractAgent): Observable<BaseEvent> {

      return next.run(input).pipe(
        map((event) => {
          const timestamp = Date.now();
          this.timestamps.set(event.type, timestamp);
          return {
            ...event,
            timestamp,
          } as BaseEvent & { timestamp: number };
        })
      );
    }
  }

  class BufferingMiddleware extends Middleware {
    private buffer: string = "";

    public run(input: RunAgentInput, next: AbstractAgent): Observable<BaseEvent> {

      return new Observable<BaseEvent>((subscriber) => {
        const subscription = next.run(input).subscribe({
          next: (event) => {
            if (event.type === EventType.TEXT_MESSAGE_CHUNK) {
              const chunkEvent = event as TextMessageChunkEvent;
              this.buffer += chunkEvent.delta;

              // Only emit when we have a complete word or punctuation
              if (chunkEvent.delta === " " || chunkEvent.delta === "!") {
                const bufferedEvent: TextMessageChunkEvent = {
                  ...chunkEvent,
                  delta: this.buffer,
                };
                this.buffer = "";
                subscriber.next(bufferedEvent);
              }
            } else {
              // Pass through non-text events immediately
              subscriber.next(event);
            }
          },
          error: (err) => subscriber.error(err),
          complete: () => subscriber.complete(),
        });

        return () => subscription.unsubscribe();
      });
    }
  }

  class DelayMiddleware extends Middleware {
    constructor(private delayMs: number) {
      super();
    }

    public run(input: RunAgentInput, next: AbstractAgent): Observable<BaseEvent> {

      return next.run(input).pipe(
        concatMap((event) =>
          new Observable<BaseEvent>((subscriber) => {
            setTimeout(() => {
              subscriber.next(event);
              subscriber.complete();
            }, this.delayMs);
          })
        )
      );
    }
  }

  it("should stream events live through middleware chain", async () => {
    const agent = new StreamingAgent();
    const timestampMiddleware = new TimestampMiddleware();

    agent.use(timestampMiddleware);

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
    const eventTimes: number[] = [];

    const chainedAgent = agent["middlewares"].reduceRight(
      (nextAgent: AbstractAgent, middleware) => ({
        run: (i: RunAgentInput) => middleware.run(i, nextAgent),
      } as AbstractAgent),
      agent
    );

    const startTime = Date.now();

    await new Promise<void>((resolve) => {
      chainedAgent.run(input).subscribe({
        next: (event) => {
          events.push(event);
          eventTimes.push(Date.now() - startTime);
        },
        complete: () => resolve(),
      });
    });

    // Should receive events over time, not all at once
    expect(events.length).toBe(6); // RUN_STARTED, 4 chunks, RUN_FINISHED
    expect(events[0].type).toBe(EventType.RUN_STARTED);
    expect(events[5].type).toBe(EventType.RUN_FINISHED);

    // Check that chunks arrived over time (with ~50ms intervals)
    expect(eventTimes[2] - eventTimes[1]).toBeGreaterThanOrEqual(40);
    expect(eventTimes[3] - eventTimes[2]).toBeGreaterThanOrEqual(40);
  });

  it("should buffer and transform events in real-time", async () => {
    const agent = new StreamingAgent();
    const bufferMiddleware = new BufferingMiddleware();

    agent.use(bufferMiddleware);

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

    await new Promise<void>((resolve) => {
      bufferMiddleware.run(input, agent).subscribe({
        next: (event) => events.push(event),
        complete: () => resolve(),
      });
    });

    // BufferingMiddleware should have combined chunks
    const textEvents = events.filter(e => e.type === EventType.TEXT_MESSAGE_CHUNK);
    expect(textEvents.length).toBe(2); // "Hello " and "world!"
    expect((textEvents[0] as TextMessageChunkEvent).delta).toBe("Hello ");
    expect((textEvents[1] as TextMessageChunkEvent).delta).toBe("world!");
  });

  it("should process events through multiple middleware in order", async () => {
    const agent = new StreamingAgent();
    const timestampMiddleware = new TimestampMiddleware();
    const delayMiddleware = new DelayMiddleware(10);

    agent.use(timestampMiddleware, delayMiddleware);

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
    const startTime = Date.now();

    const chainedAgent = agent["middlewares"].reduceRight(
      (nextAgent: AbstractAgent, middleware) => ({
        run: (i: RunAgentInput) => middleware.run(i, nextAgent),
      } as AbstractAgent),
      agent
    );

    await new Promise<void>((resolve) => {
      chainedAgent.run(input).subscribe({
        next: (event) => {
          events.push(event);
        },
        complete: () => resolve(),
      });
    });

    const totalTime = Date.now() - startTime;

    // Each event should have a timestamp from the first middleware
    events.forEach(event => {
      expect((event as any).timestamp).toBeDefined();
    });

    // The delay middleware should have added delay to each event
    expect(totalTime).toBeGreaterThanOrEqual(60); // 6 events * 10ms delay
  });

  it("should handle backpressure correctly", async () => {
    class FastProducerAgent extends AbstractAgent {
      public run(input: RunAgentInput): Observable<BaseEvent> {
        return new Observable<BaseEvent>((subscriber) => {
          subscriber.next({
            type: EventType.RUN_STARTED,
            threadId: input.threadId,
            runId: input.runId,
          });

          // Emit many events quickly
          for (let i = 0; i < 100; i++) {
            subscriber.next({
              type: EventType.TEXT_MESSAGE_CHUNK,
              role: "assistant",
              messageId: "fast-message",
              delta: i.toString(),
            } as TextMessageChunkEvent);
          }

          subscriber.next({
            type: EventType.RUN_FINISHED,
            threadId: input.threadId,
            runId: input.runId,
          });

          subscriber.complete();
        });
      }
    }

    class SlowConsumerMiddleware extends Middleware {
      public processedCount = 0;

      public run(input: RunAgentInput, next: AbstractAgent): Observable<BaseEvent> {

        return next.run(input).pipe(
          concatMap((event) =>
            new Observable<BaseEvent>((subscriber) => {
              // Simulate slow processing
              setTimeout(() => {
                this.processedCount++;
                subscriber.next(event);
                subscriber.complete();
              }, 1);
            })
          )
        );
      }
    }

    const agent = new FastProducerAgent();
    const slowMiddleware = new SlowConsumerMiddleware();

    agent.use(slowMiddleware);

    const input: RunAgentInput = {
      threadId: "test-thread",
      runId: "test-run",
      tools: [],
      context: [],
      forwardedProps: {},
      state: {},
      messages: [],
    };

    await new Promise<void>((resolve) => {
      slowMiddleware.run(input, agent).subscribe({
        complete: () => resolve(),
      });
    });

    // All events should be processed despite the speed difference
    expect(slowMiddleware.processedCount).toBe(102); // RUN_STARTED + 100 chunks + RUN_FINISHED
  });
});
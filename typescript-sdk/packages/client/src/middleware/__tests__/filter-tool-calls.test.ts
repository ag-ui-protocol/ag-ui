import { AbstractAgent } from "@/agent";
import { FilterToolCallsMiddleware } from "@/middleware/filter-tool-calls";
import { Middleware } from "@/middleware";
import {
  BaseEvent,
  EventType,
  RunAgentInput,
  ToolCallStartEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  ToolCallResultEvent,
  ToolCallChunkEvent
} from "@ag-ui/core";
import { Observable } from "rxjs";

describe("FilterToolCallsMiddleware", () => {
  class ToolCallingAgent extends AbstractAgent {
    public run(input: RunAgentInput): Observable<BaseEvent> {
      return new Observable<BaseEvent>((subscriber) => {
        // Emit RUN_STARTED
        subscriber.next({
          type: EventType.RUN_STARTED,
          threadId: input.threadId,
          runId: input.runId,
        });

        // Emit first tool call (calculator)
        const toolCall1Id = "tool-call-1";
        subscriber.next({
          type: EventType.TOOL_CALL_START,
          toolCallId: toolCall1Id,
          toolCallName: "calculator",
          parentMessageId: "message-1",
        } as ToolCallStartEvent);

        subscriber.next({
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: toolCall1Id,
          delta: '{"operation": "add", "a": 5, "b": 3}',
        } as ToolCallArgsEvent);

        subscriber.next({
          type: EventType.TOOL_CALL_END,
          toolCallId: toolCall1Id,
        } as ToolCallEndEvent);

        subscriber.next({
          type: EventType.TOOL_CALL_RESULT,
          messageId: "tool-message-1",
          toolCallId: toolCall1Id,
          content: "8",
        } as ToolCallResultEvent);

        // Emit second tool call (weather)
        const toolCall2Id = "tool-call-2";
        subscriber.next({
          type: EventType.TOOL_CALL_START,
          toolCallId: toolCall2Id,
          toolCallName: "weather",
          parentMessageId: "message-2",
        } as ToolCallStartEvent);

        subscriber.next({
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: toolCall2Id,
          delta: '{"city": "New York"}',
        } as ToolCallArgsEvent);

        subscriber.next({
          type: EventType.TOOL_CALL_END,
          toolCallId: toolCall2Id,
        } as ToolCallEndEvent);

        subscriber.next({
          type: EventType.TOOL_CALL_RESULT,
          messageId: "tool-message-2",
          toolCallId: toolCall2Id,
          content: "Sunny, 72°F",
        } as ToolCallResultEvent);

        // Emit third tool call (search)
        const toolCall3Id = "tool-call-3";
        subscriber.next({
          type: EventType.TOOL_CALL_START,
          toolCallId: toolCall3Id,
          toolCallName: "search",
          parentMessageId: "message-3",
        } as ToolCallStartEvent);

        subscriber.next({
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: toolCall3Id,
          delta: '{"query": "TypeScript middleware"}',
        } as ToolCallArgsEvent);

        subscriber.next({
          type: EventType.TOOL_CALL_END,
          toolCallId: toolCall3Id,
        } as ToolCallEndEvent);

        subscriber.next({
          type: EventType.TOOL_CALL_RESULT,
          messageId: "tool-message-3",
          toolCallId: toolCall3Id,
          content: "Results found...",
        } as ToolCallResultEvent);

        // Emit RUN_FINISHED
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

  it("should filter out disallowed tool calls", async () => {
    const agent = new ToolCallingAgent();
    const middleware = new FilterToolCallsMiddleware({
      disallowedToolCalls: ["calculator", "search"],
    });

    const events: BaseEvent[] = [];
    await new Promise<void>((resolve) => {
      middleware.run(input, agent).subscribe({
        next: (event) => events.push(event),
        complete: () => resolve(),
      });
    });

    // Should have RUN_STARTED, weather tool events (4), and RUN_FINISHED
    expect(events.length).toBe(6);

    // Check that we have RUN_STARTED
    expect(events[0].type).toBe(EventType.RUN_STARTED);

    // Check that only weather tool calls are present
    const toolCallStarts = events.filter(e => e.type === EventType.TOOL_CALL_START) as ToolCallStartEvent[];
    expect(toolCallStarts.length).toBe(1);
    expect(toolCallStarts[0].toolCallName).toBe("weather");

    // Check that calculator and search are filtered out
    const allToolNames = toolCallStarts.map(e => e.toolCallName);
    expect(allToolNames).not.toContain("calculator");
    expect(allToolNames).not.toContain("search");

    // Check that we have RUN_FINISHED
    expect(events[events.length - 1].type).toBe(EventType.RUN_FINISHED);
  });

  it("should only allow specified tool calls", async () => {
    const agent = new ToolCallingAgent();
    const middleware = new FilterToolCallsMiddleware({
      allowedToolCalls: ["weather"],
    });

    const events: BaseEvent[] = [];
    await new Promise<void>((resolve) => {
      middleware.run(input, agent).subscribe({
        next: (event) => events.push(event),
        complete: () => resolve(),
      });
    });

    // Should have RUN_STARTED, weather tool events (4), and RUN_FINISHED
    expect(events.length).toBe(6);

    // Check that only weather tool calls are present
    const toolCallStarts = events.filter(e => e.type === EventType.TOOL_CALL_START) as ToolCallStartEvent[];
    expect(toolCallStarts.length).toBe(1);
    expect(toolCallStarts[0].toolCallName).toBe("weather");

    // Verify all weather-related events are present
    const weatherToolCallId = toolCallStarts[0].toolCallId;
    const weatherArgs = events.find(e =>
      e.type === EventType.TOOL_CALL_ARGS &&
      (e as ToolCallArgsEvent).toolCallId === weatherToolCallId
    );
    expect(weatherArgs).toBeDefined();

    const weatherEnd = events.find(e =>
      e.type === EventType.TOOL_CALL_END &&
      (e as ToolCallEndEvent).toolCallId === weatherToolCallId
    );
    expect(weatherEnd).toBeDefined();

    const weatherResult = events.find(e =>
      e.type === EventType.TOOL_CALL_RESULT &&
      (e as ToolCallResultEvent).toolCallId === weatherToolCallId
    );
    expect(weatherResult).toBeDefined();
  });

  it("should filter all events for a blocked tool call", async () => {
    const agent = new ToolCallingAgent();
    const middleware = new FilterToolCallsMiddleware({
      disallowedToolCalls: ["calculator"],
    });

    const events: BaseEvent[] = [];
    await new Promise<void>((resolve) => {
      middleware.run(input, agent).subscribe({
        next: (event) => events.push(event),
        complete: () => resolve(),
      });
    });

    // Should not have any calculator-related events
    const calculatorEvents = events.filter(e => {
      if (e.type === EventType.TOOL_CALL_START) {
        return (e as ToolCallStartEvent).toolCallName === "calculator";
      }
      if (e.type === EventType.TOOL_CALL_ARGS ||
          e.type === EventType.TOOL_CALL_END ||
          e.type === EventType.TOOL_CALL_RESULT) {
        return (e as any).toolCallId === "tool-call-1";
      }
      return false;
    });

    expect(calculatorEvents.length).toBe(0);

    // But should have weather and search events
    const weatherStart = events.find(e =>
      e.type === EventType.TOOL_CALL_START &&
      (e as ToolCallStartEvent).toolCallName === "weather"
    );
    expect(weatherStart).toBeDefined();

    const searchStart = events.find(e =>
      e.type === EventType.TOOL_CALL_START &&
      (e as ToolCallStartEvent).toolCallName === "search"
    );
    expect(searchStart).toBeDefined();
  });

  it("should allow all tool calls when allowed list is empty", async () => {
    const agent = new ToolCallingAgent();
    const middleware = new FilterToolCallsMiddleware({
      allowedToolCalls: [],
    });

    const events: BaseEvent[] = [];
    await new Promise<void>((resolve) => {
      middleware.run(input, agent).subscribe({
        next: (event) => events.push(event),
        complete: () => resolve(),
      });
    });

    // No tool calls should pass through with empty allowed list
    const toolCallStarts = events.filter(e => e.type === EventType.TOOL_CALL_START);
    expect(toolCallStarts.length).toBe(0);
  });

  it("should allow all tool calls when disallowed list is empty", async () => {
    const agent = new ToolCallingAgent();
    const middleware = new FilterToolCallsMiddleware({
      disallowedToolCalls: [],
    });

    const events: BaseEvent[] = [];
    await new Promise<void>((resolve) => {
      middleware.run(input, agent).subscribe({
        next: (event) => events.push(event),
        complete: () => resolve(),
      });
    });

    // All tool calls should pass through with empty disallowed list
    const toolCallStarts = events.filter(e => e.type === EventType.TOOL_CALL_START);
    expect(toolCallStarts.length).toBe(3);
  });

  it("should throw error when both allowed and disallowed are specified", () => {
    expect(() => {
      new FilterToolCallsMiddleware({
        allowedToolCalls: ["calculator"],
        disallowedToolCalls: ["weather"],
      } as any);
    }).toThrow("Cannot specify both allowedToolCalls and disallowedToolCalls");
  });

  it("should throw error when neither allowed nor disallowed are specified", () => {
    expect(() => {
      new FilterToolCallsMiddleware({} as any);
    }).toThrow("Must specify either allowedToolCalls or disallowedToolCalls");
  });

  // Test removed - middleware now requires next parameter

  it("should work in a middleware chain", async () => {
    const agent = new ToolCallingAgent();

    // First middleware filters out calculator
    const filterMiddleware = new FilterToolCallsMiddleware({
      disallowedToolCalls: ["calculator"],
    });

    // Second middleware could be any other middleware
    class EventCounterMiddleware extends Middleware {
      public eventCount = 0;

      public run(input: RunAgentInput, next: AbstractAgent): Observable<BaseEvent> {

        return new Observable<BaseEvent>((subscriber) => {
          const subscription = next.run(input).subscribe({
            next: (event) => {
              this.eventCount++;
              subscriber.next(event);
            },
            error: (err) => subscriber.error(err),
            complete: () => subscriber.complete(),
          });

          return () => subscription.unsubscribe();
        });
      }
    }

    const counterMiddleware = new EventCounterMiddleware();

    agent.use(counterMiddleware, filterMiddleware);

    const input: RunAgentInput = {
      threadId: "test-thread",
      runId: "test-run",
      tools: [],
      context: [],
      forwardedProps: {},
      state: {},
      messages: [],
    };

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

    // Counter should have seen the filtered events
    expect(counterMiddleware.eventCount).toBe(10); // 2 run events + 8 tool events (2 tools * 4 events)

    // Final output should not have calculator events
    const toolCallStarts = events.filter(e => e.type === EventType.TOOL_CALL_START) as ToolCallStartEvent[];
    expect(toolCallStarts.map(e => e.toolCallName)).toEqual(["weather", "search"]);
  });

  it("should filter TOOL_CALL_CHUNK events that are disallowed", async () => {
    class ChunkEmittingAgent extends AbstractAgent {
      public run(input: RunAgentInput): Observable<BaseEvent> {
        return new Observable<BaseEvent>((subscriber) => {
          // Emit RUN_STARTED
          subscriber.next({
            type: EventType.RUN_STARTED,
            threadId: input.threadId,
            runId: input.runId,
          });

          // Emit calculator tool as chunks (should be filtered)
          subscriber.next({
            type: EventType.TOOL_CALL_CHUNK,
            toolCallId: "tool-1",
            toolCallName: "calculator",
            parentMessageId: "msg-1",
            delta: '{"operation": "add",',
          } as ToolCallChunkEvent);

          subscriber.next({
            type: EventType.TOOL_CALL_CHUNK,
            toolCallId: "tool-1",
            delta: '"a": 5, "b": 3}',
          } as ToolCallChunkEvent);

          // Emit weather tool as chunks (should pass through)
          subscriber.next({
            type: EventType.TOOL_CALL_CHUNK,
            toolCallId: "tool-2",
            toolCallName: "weather",
            parentMessageId: "msg-2",
            delta: '{"city": "Paris"}',
          } as ToolCallChunkEvent);

          // Emit a close event to trigger chunk transformation
          subscriber.next({
            type: EventType.RUN_FINISHED,
            threadId: input.threadId,
            runId: input.runId,
          });

          subscriber.complete();
        });
      }
    }

    const agent = new ChunkEmittingAgent();
    const middleware = new FilterToolCallsMiddleware({
      disallowedToolCalls: ["calculator"],
    });

    const events: BaseEvent[] = [];
    await new Promise<void>((resolve) => {
      middleware.run(input, agent).subscribe({
        next: (event) => events.push(event),
        complete: () => resolve(),
      });
    });

    // Should have RUN_STARTED, weather tool events (START, ARGS, END), and RUN_FINISHED
    const toolCallStarts = events.filter(e => e.type === EventType.TOOL_CALL_START) as ToolCallStartEvent[];
    expect(toolCallStarts.length).toBe(1);
    expect(toolCallStarts[0].toolCallName).toBe("weather");

    // Calculator chunks should have been transformed and then filtered
    const calculatorEvents = events.filter(e => {
      if (e.type === EventType.TOOL_CALL_START) {
        return (e as ToolCallStartEvent).toolCallName === "calculator";
      }
      if (e.type === EventType.TOOL_CALL_ARGS ||
          e.type === EventType.TOOL_CALL_END) {
        return (e as any).toolCallId === "tool-1";
      }
      return false;
    });
    expect(calculatorEvents.length).toBe(0);

    // No TOOL_CALL_CHUNK events should remain (all transformed)
    const chunkEvents = events.filter(e => e.type === EventType.TOOL_CALL_CHUNK);
    expect(chunkEvents.length).toBe(0);
  });

  it("should only allow specified tool calls from chunks", async () => {
    class ChunkEmittingAgent extends AbstractAgent {
      public run(input: RunAgentInput): Observable<BaseEvent> {
        return new Observable<BaseEvent>((subscriber) => {
          // Emit RUN_STARTED
          subscriber.next({
            type: EventType.RUN_STARTED,
            threadId: input.threadId,
            runId: input.runId,
          });

          // Emit three different tools as chunks
          subscriber.next({
            type: EventType.TOOL_CALL_CHUNK,
            toolCallId: "tool-1",
            toolCallName: "calculator",
            parentMessageId: "msg-1",
            delta: '{"test": "data"}',
          } as ToolCallChunkEvent);

          subscriber.next({
            type: EventType.TOOL_CALL_CHUNK,
            toolCallId: "tool-2",
            toolCallName: "weather",
            parentMessageId: "msg-2",
            delta: '{"city": "London"}',
          } as ToolCallChunkEvent);

          subscriber.next({
            type: EventType.TOOL_CALL_CHUNK,
            toolCallId: "tool-3",
            toolCallName: "search",
            parentMessageId: "msg-3",
            delta: '{"query": "test"}',
          } as ToolCallChunkEvent);

          // Close event
          subscriber.next({
            type: EventType.RUN_FINISHED,
            threadId: input.threadId,
            runId: input.runId,
          });

          subscriber.complete();
        });
      }
    }

    const agent = new ChunkEmittingAgent();
    const middleware = new FilterToolCallsMiddleware({
      allowedToolCalls: ["weather"],
    });

    const events: BaseEvent[] = [];
    await new Promise<void>((resolve) => {
      middleware.run(input, agent).subscribe({
        next: (event) => events.push(event),
        complete: () => resolve(),
      });
    });

    // Should only have weather tool events
    const toolCallStarts = events.filter(e => e.type === EventType.TOOL_CALL_START) as ToolCallStartEvent[];
    expect(toolCallStarts.length).toBe(1);
    expect(toolCallStarts[0].toolCallName).toBe("weather");

    // Verify weather tool has all its events
    const weatherEvents = events.filter(e => {
      if (e.type === EventType.TOOL_CALL_START ||
          e.type === EventType.TOOL_CALL_ARGS ||
          e.type === EventType.TOOL_CALL_END) {
        return (e as any).toolCallId === "tool-2";
      }
      return false;
    });
    expect(weatherEvents.length).toBe(3); // START, ARGS, END
  });
});
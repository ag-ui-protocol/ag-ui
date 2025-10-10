import { toArray } from "rxjs/operators";
import { EventType, BaseEvent, RunAgentInput } from "@ag-ui/core";
import { AbstractAgent } from "../../agent/agent";
import { Observable, lastValueFrom } from "rxjs";
import { RunAgentParameters } from "../../agent/types";

// Mock uuid
jest.mock("uuid", () => ({
  v4: jest.fn().mockReturnValue("mock-uuid"),
}));

// Create a test agent that extends AbstractAgent
class TestAgent extends AbstractAgent {
  run(input: RunAgentInput): Observable<BaseEvent> {
    const messageId = "test-message-id";
    return new Observable<BaseEvent>((observer) => {
      observer.next({
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
        timestamp: Date.now(),
      } as BaseEvent);

      observer.next({
        type: EventType.TEXT_MESSAGE_START,
        messageId,
        timestamp: Date.now(),
      } as BaseEvent);

      observer.next({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId,
        delta: "Hello world!",
        timestamp: Date.now(),
      } as BaseEvent);

      observer.next({
        type: EventType.TEXT_MESSAGE_END,
        messageId,
        timestamp: Date.now(),
      } as BaseEvent);

      observer.next({
        type: EventType.RUN_FINISHED,
        threadId: input.threadId,
        runId: input.runId,
        timestamp: Date.now(),
      } as BaseEvent);

      observer.complete();
    });
  }
}

// Agent that emits text chunks instead of start/content/end events
class ChunkTestAgent extends AbstractAgent {
  run(input: RunAgentInput): Observable<BaseEvent> {
    const messageId = "test-chunk-id";
    return new Observable<BaseEvent>((observer) => {
      observer.next({
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
        timestamp: Date.now(),
      } as BaseEvent);

      // Emit a text message chunk instead of separate start/content/end events
      observer.next({
        type: EventType.TEXT_MESSAGE_CHUNK,
        messageId,
        delta: "Hello from chunks!",
        timestamp: Date.now(),
      } as BaseEvent);

      observer.next({
        type: EventType.RUN_FINISHED,
        threadId: input.threadId,
        runId: input.runId,
        timestamp: Date.now(),
      } as BaseEvent);

      observer.complete();
    });
  }
}

// Agent that emits tool call events with results
class ToolCallTestAgent extends AbstractAgent {
  run(input: RunAgentInput): Observable<BaseEvent> {
    const toolCallId = "test-tool-call-id";
    const toolCallName = "get_weather";
    return new Observable<BaseEvent>((observer) => {
      observer.next({
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
        timestamp: Date.now(),
      } as BaseEvent);

      // Start tool call
      observer.next({
        type: EventType.TOOL_CALL_START,
        toolCallId,
        toolCallName,
        timestamp: Date.now(),
      } as BaseEvent);

      // Tool call arguments
      observer.next({
        type: EventType.TOOL_CALL_ARGS,
        toolCallId,
        delta: '{"location": "San Francisco"}',
        timestamp: Date.now(),
      } as BaseEvent);

      // End tool call
      observer.next({
        type: EventType.TOOL_CALL_END,
        toolCallId,
        timestamp: Date.now(),
      } as BaseEvent);

      // Tool call result
      observer.next({
        messageId: "test-message-id",
        type: EventType.TOOL_CALL_RESULT,
        toolCallId,
        content: "The weather in San Francisco is 72°F and sunny.",
        timestamp: Date.now(),
      } as BaseEvent);

      observer.next({
        type: EventType.RUN_FINISHED,
        threadId: input.threadId,
        runId: input.runId,
        timestamp: Date.now(),
      } as BaseEvent);

      observer.complete();
    });
  }
}

describe("AbstractAgent.legacy_to_be_removed_runAgentBridged", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should correctly convert events to legacy format", async () => {
    // Setup agent with mock IDs
    const agent = new TestAgent({
      threadId: "test-thread-id",
      agentId: "test-agent-id",
    });

    // Get the observable that emits legacy events
    const legacy$ = agent.legacy_to_be_removed_runAgentBridged();

    // Collect all emitted events
    const legacyEvents = await lastValueFrom(legacy$.pipe(toArray()));

    // Verify events are in correct legacy format
    expect(legacyEvents).toHaveLength(3); // Start, Content, End

    // TextMessageStart
    expect(legacyEvents[0]).toMatchObject({
      type: "TextMessageStart",
      messageId: "test-message-id",
    });

    // TextMessageContent
    expect(legacyEvents[1]).toMatchObject({
      type: "TextMessageContent",
      messageId: "test-message-id",
      content: "Hello world!",
    });

    // TextMessageEnd
    expect(legacyEvents[2]).toMatchObject({
      type: "TextMessageEnd",
      messageId: "test-message-id",
    });

    // Final AgentStateMessage
    // expect(legacyEvents[3]).toMatchObject({
    //   type: "AgentStateMessage",
    //   threadId: "test-thread-id",
    //   agentName: "test-agent-id",
    //   active: false,
    // });
  });

  it("should pass configuration to the underlying run method", async () => {
    // Setup agent with mock IDs
    const agent = new TestAgent({
      threadId: "test-thread-id",
      agentId: "test-agent-id",
    });

    // Spy on the run method
    const runSpy = jest.spyOn(agent as any, "run");

    // Create config with compatible tool format
    const config: RunAgentParameters = {
      tools: [],
      context: [{ value: "test context", description: "Test description" }],
      forwardedProps: { foo: "bar" },
    };

    // Call legacy bridged method with config
    agent.legacy_to_be_removed_runAgentBridged(config);

    // Verify run method was called with correct input
    expect(runSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "test-thread-id",
        runId: "mock-uuid",
        tools: config.tools,
        context: config.context,
        forwardedProps: config.forwardedProps,
      }),
    );
  });

  it("should include agent ID in the legacy events when converting", async () => {
    // Setup agent with mock IDs
    const agent = new TestAgent({
      threadId: "test-thread-id",
      agentId: "test-agent-id",
    });

    // Set up a state snapshot to test agent state in legacy format
    const runWithStateSnapshot = jest
      .fn()
      .mockImplementation((input: RunAgentInput): Observable<BaseEvent> => {
        return new Observable<BaseEvent>((observer) => {
          observer.next({
            type: EventType.RUN_STARTED,
            threadId: input.threadId,
            runId: input.runId,
            timestamp: Date.now(),
          } as BaseEvent);

          // Add a state snapshot event
          observer.next({
            type: EventType.STATE_SNAPSHOT,
            snapshot: { test: "state" },
            timestamp: Date.now(),
          } as BaseEvent);

          observer.next({
            type: EventType.RUN_FINISHED,
            threadId: input.threadId,
            runId: input.runId,
            timestamp: Date.now(),
          } as BaseEvent);

          observer.complete();
        });
      });

    // Override the run method for this test
    jest.spyOn(agent as any, "run").mockImplementation(runWithStateSnapshot);

    // Get the observable that emits legacy events
    const legacy$ = agent.legacy_to_be_removed_runAgentBridged();

    // Collect all emitted events
    const legacyEvents = await lastValueFrom(legacy$.pipe(toArray()));

    // Find AgentStateMessage events
    const stateEvents = legacyEvents.filter((e) => e.type === "AgentStateMessage");

    // Should have at least one state event
    expect(stateEvents.length).toBeGreaterThan(0);

    // All state events should include the agent ID
    stateEvents.forEach((event) => {
      expect(event).toMatchObject({
        agentName: "test-agent-id",
        threadId: "test-thread-id",
        state: expect.any(String),
      });

      // Verify that state was correctly serialized
      if (event.state) {
        const parsedState = JSON.parse(event.state);
        expect(parsedState).toMatchObject({ test: "state" });
      }
    });
  });

  it("should transform text message chunks into legacy text message events", async () => {
    // Setup agent with mock IDs
    const agent = new ChunkTestAgent({
      threadId: "test-thread-id",
      agentId: "test-agent-id",
    });

    // Get the observable that emits legacy events
    const legacy$ = agent.legacy_to_be_removed_runAgentBridged();

    // Collect all emitted events
    const legacyEvents = await lastValueFrom(legacy$.pipe(toArray()));

    // Verify events are in correct legacy format
    expect(legacyEvents).toHaveLength(3); // Start, Content, End

    // TextMessageStart
    expect(legacyEvents[0]).toMatchObject({
      type: "TextMessageStart",
      messageId: "test-chunk-id",
    });

    // TextMessageContent
    expect(legacyEvents[1]).toMatchObject({
      type: "TextMessageContent",
      messageId: "test-chunk-id",
      content: "Hello from chunks!",
    });

    // TextMessageEnd
    expect(legacyEvents[2]).toMatchObject({
      type: "TextMessageEnd",
      messageId: "test-chunk-id",
    });

    // Final AgentStateMessage
    // expect(legacyEvents[3]).toMatchObject({
    //   type: "AgentStateMessage",
    //   threadId: "test-thread-id",
    //   agentName: "test-agent-id",
    //   active: false,
    // });
  });

  it("should transform tool call events with results into legacy events with correct tool name", async () => {
    // Setup agent with mock IDs
    const agent = new ToolCallTestAgent({
      threadId: "test-thread-id",
      agentId: "test-agent-id",
    });

    // Get the observable that emits legacy events
    const legacy$ = agent.legacy_to_be_removed_runAgentBridged();

    // Collect all emitted events
    const legacyEvents = await lastValueFrom(legacy$.pipe(toArray()));

    // Verify events are in correct legacy format
    expect(legacyEvents).toHaveLength(4); // ActionExecutionStart, ActionExecutionArgs, ActionExecutionEnd, ActionExecutionResult

    // ActionExecutionStart
    expect(legacyEvents[0]).toMatchObject({
      type: "ActionExecutionStart",
      actionExecutionId: "test-tool-call-id",
      actionName: "get_weather",
    });

    // ActionExecutionArgs
    expect(legacyEvents[1]).toMatchObject({
      type: "ActionExecutionArgs",
      actionExecutionId: "test-tool-call-id",
      args: '{"location": "San Francisco"}',
    });

    // ActionExecutionEnd
    expect(legacyEvents[2]).toMatchObject({
      type: "ActionExecutionEnd",
      actionExecutionId: "test-tool-call-id",
    });

    // ActionExecutionResult - this should include the tool name
    expect(legacyEvents[3]).toMatchObject({
      type: "ActionExecutionResult",
      actionExecutionId: "test-tool-call-id",
      actionName: "get_weather", // This verifies the tool name is correctly included
      result: "The weather in San Francisco is 72°F and sunny.",
    });

    // Final AgentStateMessage
    // expect(legacyEvents[4]).toMatchObject({
    //   type: "AgentStateMessage",
    //   threadId: "test-thread-id",
    //   agentName: "test-agent-id",
    //   active: false,
    // });
  });
});

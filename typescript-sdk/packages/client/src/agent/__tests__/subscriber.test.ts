import { AbstractAgent } from "../agent";
import { AgentSubscriber } from "../subscriber";
import {
  BaseEvent,
  EventType,
  Message,
  RunAgentInput,
  TextMessageStartEvent,
  TextMessageContentEvent,
  TextMessageEndEvent,
  StateSnapshotEvent,
  RunStartedEvent,
  RunFinishedEvent,
  ToolCallStartEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  ToolCallResultEvent,
  CustomEvent,
  StepStartedEvent,
  StepFinishedEvent,
} from "@ag-ui/core";
import { Observable, of, throwError, from } from "rxjs";
import { mergeMap } from "rxjs/operators";

// Mock uuid module
jest.mock("uuid", () => ({
  v4: jest.fn().mockReturnValue("mock-uuid"),
}));

// Mock utils with handling for undefined values
jest.mock("@/utils", () => ({
  structuredClone_: (obj: any) => {
    if (obj === undefined) return undefined;
    const jsonString = JSON.stringify(obj);
    if (jsonString === undefined || jsonString === "undefined") return undefined;
    return JSON.parse(jsonString);
  },
}));

// Mock the verify modules but NOT apply - we want to test against real defaultApplyEvents
jest.mock("@/verify", () => ({
  verifyEvents: jest.fn(() => (source$: Observable<any>) => source$),
}));

jest.mock("@/chunks", () => ({
  transformChunks: jest.fn(() => (source$: Observable<any>) => source$),
}));

// Create a test agent implementation
class TestAgent extends AbstractAgent {
  private eventsToEmit: BaseEvent[] = [];

  setEventsToEmit(events: BaseEvent[]) {
    this.eventsToEmit = events;
  }

  protected run(input: RunAgentInput): Observable<BaseEvent> {
    return of(...this.eventsToEmit);
  }
}

describe("AgentSubscriber", () => {
  let agent: TestAgent;
  let mockSubscriber: AgentSubscriber;

  beforeEach(() => {
    jest.clearAllMocks();

    agent = new TestAgent({
      threadId: "test-thread",
      initialMessages: [
        {
          id: "msg-1",
          role: "user",
          content: "Hello",
        },
      ],
      initialState: { counter: 0 },
    });

    mockSubscriber = {
      onEvent: jest.fn(),
      onRunStartedEvent: jest.fn(),
      onRunFinishedEvent: jest.fn(),
      onTextMessageStartEvent: jest.fn(),
      onTextMessageContentEvent: jest.fn(),
      onTextMessageEndEvent: jest.fn(),
      onToolCallStartEvent: jest.fn(),
      onToolCallArgsEvent: jest.fn(),
      onToolCallEndEvent: jest.fn(),
      onToolCallResultEvent: jest.fn(),
      onCustomEvent: jest.fn(),
      onStateSnapshotEvent: jest.fn(),
      onMessagesChanged: jest.fn(),
      onStateChanged: jest.fn(),
      onNewMessage: jest.fn(),
      onNewToolCall: jest.fn(),
      onRunInitialized: jest.fn(),
      onRunFailed: jest.fn(),
      onRunFinalized: jest.fn(),
    };
  });

  describe("subscribe/unsubscribe functionality", () => {
    it("should allow subscribing and unsubscribing", () => {
      // Initially no subscribers
      expect(agent.subscribers).toHaveLength(0);

      // Subscribe
      const subscription = agent.subscribe(mockSubscriber);
      expect(agent.subscribers).toHaveLength(1);
      expect(agent.subscribers[0]).toBe(mockSubscriber);

      // Unsubscribe
      subscription.unsubscribe();
      expect(agent.subscribers).toHaveLength(0);
    });

    it("should support multiple subscribers", () => {
      const subscriber2: AgentSubscriber = {
        onEvent: jest.fn(),
      };

      agent.subscribe(mockSubscriber);
      agent.subscribe(subscriber2);

      expect(agent.subscribers).toHaveLength(2);
      expect(agent.subscribers[0]).toBe(mockSubscriber);
      expect(agent.subscribers[1]).toBe(subscriber2);
    });

    it("should only remove the specific subscriber on unsubscribe", () => {
      const subscriber2: AgentSubscriber = {
        onEvent: jest.fn(),
      };

      const subscription1 = agent.subscribe(mockSubscriber);
      const subscription2 = agent.subscribe(subscriber2);

      expect(agent.subscribers).toHaveLength(2);

      subscription1.unsubscribe();
      expect(agent.subscribers).toHaveLength(1);
      expect(agent.subscribers[0]).toBe(subscriber2);

      subscription2.unsubscribe();
      expect(agent.subscribers).toHaveLength(0);
    });
  });

  describe("temporary subscribers via runAgent", () => {
    it("should accept a temporary subscriber via runAgent parameter", async () => {
      const temporarySubscriber: AgentSubscriber = {
        onRunStartedEvent: jest.fn(),
        onRunFinishedEvent: jest.fn(),
      };

      const runStartedEvent: RunStartedEvent = {
        type: EventType.RUN_STARTED,
        threadId: "test-thread",
        runId: "test-run",
      };

      const runFinishedEvent: RunFinishedEvent = {
        type: EventType.RUN_FINISHED,
        threadId: "test-thread",
        runId: "test-run",
        result: "test-result",
      };

      agent.setEventsToEmit([runStartedEvent, runFinishedEvent]);

      await agent.runAgent({}, temporarySubscriber);

      // The temporary subscriber should have been called
      expect(temporarySubscriber.onRunStartedEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event: runStartedEvent,
          messages: agent.messages,
          state: agent.state,
          agent,
        }),
      );

      expect(temporarySubscriber.onRunFinishedEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event: runFinishedEvent,
          result: "test-result",
          messages: agent.messages,
          state: agent.state,
          agent,
        }),
      );
    });

    it("should combine permanent and temporary subscribers", async () => {
      const permanentSubscriber: AgentSubscriber = {
        onRunStartedEvent: jest.fn(),
      };

      const temporarySubscriber: AgentSubscriber = {
        onRunStartedEvent: jest.fn(),
      };

      agent.subscribe(permanentSubscriber);

      const runStartedEvent: RunStartedEvent = {
        type: EventType.RUN_STARTED,
        threadId: "test-thread",
        runId: "test-run",
      };

      agent.setEventsToEmit([runStartedEvent]);

      await agent.runAgent({}, temporarySubscriber);

      // Both subscribers should have been called
      expect(permanentSubscriber.onRunStartedEvent).toHaveBeenCalled();
      expect(temporarySubscriber.onRunStartedEvent).toHaveBeenCalled();
    });
  });

  describe("mutation capabilities", () => {
    it("should allow subscribers to mutate messages", async () => {
      const newMessage: Message = {
        id: "new-msg",
        role: "assistant",
        content: "I was added by subscriber",
      };

      const mutatingSubscriber: AgentSubscriber = {
        onRunInitialized: jest.fn().mockReturnValue({
          messages: [...agent.messages, newMessage],
        }),
        onMessagesChanged: jest.fn(),
      };

      // Emit a dummy event to avoid EmptyError
      agent.setEventsToEmit([
        {
          type: EventType.RUN_STARTED,
          threadId: "test",
          runId: "test",
        } as RunStartedEvent,
      ]);

      await agent.runAgent({}, mutatingSubscriber);

      // Verify the subscriber was called with the initial messages
      expect(mutatingSubscriber.onRunInitialized).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [
            {
              id: "msg-1",
              role: "user",
              content: "Hello",
            },
          ],
        }),
      );

      // Verify the agent's messages were updated
      expect(agent.messages).toHaveLength(2);
      expect(agent.messages[1]).toEqual(newMessage);

      // Verify onMessagesChanged was called
      expect(mutatingSubscriber.onMessagesChanged).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: agent.messages,
        }),
      );
    });

    it("should allow subscribers to mutate state", async () => {
      const mutatingSubscriber: AgentSubscriber = {
        onRunInitialized: jest.fn().mockReturnValue({
          state: { counter: 42, newField: "added" },
        }),
        onStateChanged: jest.fn(),
      };

      // Emit a dummy event to avoid EmptyError
      agent.setEventsToEmit([
        {
          type: EventType.RUN_STARTED,
          threadId: "test",
          runId: "test",
        } as RunStartedEvent,
      ]);

      await agent.runAgent({}, mutatingSubscriber);

      // Verify the subscriber was called with the initial state
      expect(mutatingSubscriber.onRunInitialized).toHaveBeenCalledWith(
        expect.objectContaining({
          state: { counter: 0 },
        }),
      );

      // Verify the agent's state was updated
      expect(agent.state).toEqual({ counter: 42, newField: "added" });

      // Verify onStateChanged was called
      expect(mutatingSubscriber.onStateChanged).toHaveBeenCalledWith(
        expect.objectContaining({
          state: agent.state,
        }),
      );
    });

    it("should allow mutations in event handlers", async () => {
      const stateEvent: StateSnapshotEvent = {
        type: EventType.STATE_SNAPSHOT,
        snapshot: { newCounter: 100 },
      };

      const mutatingSubscriber: AgentSubscriber = {
        onStateSnapshotEvent: jest.fn().mockReturnValue({
          state: { modifiedBySubscriber: true },
          stopPropagation: true, // Prevent the event from applying its snapshot
        }),
        onStateChanged: jest.fn(),
      };

      agent.setEventsToEmit([stateEvent]);

      await agent.runAgent({}, mutatingSubscriber);

      expect(mutatingSubscriber.onStateSnapshotEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event: stateEvent,
        }),
      );

      // State should be updated by the subscriber
      expect(agent.state).toEqual({ modifiedBySubscriber: true });
      expect(mutatingSubscriber.onStateChanged).toHaveBeenCalled();
    });
  });

  describe("stopPropagation functionality", () => {
    it("should stop propagation to subsequent subscribers when stopPropagation is true", async () => {
      const firstSubscriber: AgentSubscriber = {
        onRunInitialized: jest.fn().mockReturnValue({
          stopPropagation: true,
        }),
      };

      const secondSubscriber: AgentSubscriber = {
        onRunInitialized: jest.fn(),
      };

      agent.subscribe(firstSubscriber);
      agent.subscribe(secondSubscriber);

      // Emit a dummy event to avoid EmptyError
      agent.setEventsToEmit([
        {
          type: EventType.RUN_STARTED,
          threadId: "test",
          runId: "test",
        } as RunStartedEvent,
      ]);

      await agent.runAgent({});

      // First subscriber should be called
      expect(firstSubscriber.onRunInitialized).toHaveBeenCalled();

      // Second subscriber should NOT be called due to stopPropagation
      expect(secondSubscriber.onRunInitialized).not.toHaveBeenCalled();
    });

    it("should continue to next subscriber when stopPropagation is false", async () => {
      const firstSubscriber: AgentSubscriber = {
        onRunInitialized: jest.fn().mockReturnValue({
          stopPropagation: false,
        }),
      };

      const secondSubscriber: AgentSubscriber = {
        onRunInitialized: jest.fn(),
      };

      agent.subscribe(firstSubscriber);
      agent.subscribe(secondSubscriber);

      agent.setEventsToEmit([
        { type: EventType.RUN_STARTED, threadId: "test", runId: "test" } as RunStartedEvent,
      ]);

      await agent.runAgent({});

      // Both subscribers should be called
      expect(firstSubscriber.onRunInitialized).toHaveBeenCalled();
      expect(secondSubscriber.onRunInitialized).toHaveBeenCalled();
    });

    it("should continue to next subscriber when stopPropagation is undefined", async () => {
      const firstSubscriber: AgentSubscriber = {
        onRunInitialized: jest.fn().mockReturnValue({}), // No stopPropagation field
      };

      const secondSubscriber: AgentSubscriber = {
        onRunInitialized: jest.fn(),
      };

      agent.subscribe(firstSubscriber);
      agent.subscribe(secondSubscriber);

      agent.setEventsToEmit([
        { type: EventType.RUN_STARTED, threadId: "test", runId: "test" } as RunStartedEvent,
      ]);

      await agent.runAgent({});

      // Both subscribers should be called
      expect(firstSubscriber.onRunInitialized).toHaveBeenCalled();
      expect(secondSubscriber.onRunInitialized).toHaveBeenCalled();
    });

    it("should stop default behavior on error when stopPropagation is true", async () => {
      const errorHandlingSubscriber: AgentSubscriber = {
        onRunFailed: jest.fn().mockReturnValue({
          stopPropagation: true,
        }),
      };

      // Create an agent that throws an error
      class ErrorAgent extends AbstractAgent {
        protected run(input: RunAgentInput): Observable<BaseEvent> {
          return from([
            {
              type: EventType.RUN_STARTED,
              threadId: input.threadId,
              runId: input.runId,
            } as RunStartedEvent,
          ]).pipe(mergeMap(() => throwError(() => new Error("Test error"))));
        }
      }

      const errorAgent = new ErrorAgent();
      errorAgent.subscribe(errorHandlingSubscriber);

      // Mock console.error to check if it's called
      const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation();

      // This should not throw because the subscriber handles the error
      await expect(errorAgent.runAgent({})).resolves.toBeDefined();

      expect(errorHandlingSubscriber.onRunFailed).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.any(Error),
        }),
      );

      // Console.error should NOT be called because subscriber handled the error
      expect(consoleErrorSpy).not.toHaveBeenCalled();

      consoleErrorSpy.mockRestore();
    });

    it("should allow default error behavior when stopPropagation is false", async () => {
      const errorHandlingSubscriber: AgentSubscriber = {
        onRunFailed: jest.fn().mockReturnValue({
          stopPropagation: false,
        }),
      };

      // Create an agent that throws an error
      class ErrorAgent extends AbstractAgent {
        protected run(input: RunAgentInput): Observable<BaseEvent> {
          return from([
            {
              type: EventType.RUN_STARTED,
              threadId: input.threadId,
              runId: input.runId,
            } as RunStartedEvent,
          ]).pipe(mergeMap(() => throwError(() => new Error("Test error"))));
        }
      }

      const errorAgent = new ErrorAgent();
      errorAgent.subscribe(errorHandlingSubscriber);

      // Mock console.error to check if it's called
      const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation();

      // This should throw because the subscriber doesn't stop propagation
      await expect(errorAgent.runAgent({})).rejects.toThrow("Test error");

      expect(errorHandlingSubscriber.onRunFailed).toHaveBeenCalled();

      // Console.error should be called because error propagated
      expect(consoleErrorSpy).toHaveBeenCalledWith("Agent execution failed:", expect.any(Error));

      consoleErrorSpy.mockRestore();
    });
  });

  describe("subscriber order and chaining", () => {
    it("should call subscribers in the order they were added", async () => {
      const callOrder: string[] = [];

      const subscriber1: AgentSubscriber = {
        onRunInitialized: jest.fn().mockImplementation(() => {
          callOrder.push("subscriber1");
        }),
      };

      const subscriber2: AgentSubscriber = {
        onRunInitialized: jest.fn().mockImplementation(() => {
          callOrder.push("subscriber2");
        }),
      };

      const subscriber3: AgentSubscriber = {
        onRunInitialized: jest.fn().mockImplementation(() => {
          callOrder.push("subscriber3");
        }),
      };

      agent.subscribe(subscriber1);
      agent.subscribe(subscriber2);
      agent.subscribe(subscriber3);

      agent.setEventsToEmit([
        { type: EventType.RUN_STARTED, threadId: "test", runId: "test" } as RunStartedEvent,
      ]);

      await agent.runAgent({});

      expect(callOrder).toEqual(["subscriber1", "subscriber2", "subscriber3"]);
    });

    it("should pass mutations from one subscriber to the next", async () => {
      const subscriber1: AgentSubscriber = {
        onRunInitialized: jest.fn().mockReturnValue({
          state: { step: 1 },
        }),
      };

      const subscriber2: AgentSubscriber = {
        onRunInitialized: jest.fn().mockImplementation((params) => {
          // Should receive the state modified by subscriber1
          expect(params.state).toEqual({ step: 1 });
          return {
            state: { step: 2 },
          };
        }),
      };

      const subscriber3: AgentSubscriber = {
        onRunInitialized: jest.fn().mockImplementation((params) => {
          // Should receive the state modified by subscriber2
          expect(params.state).toEqual({ step: 2 });
          return {
            state: { step: 3 },
          };
        }),
      };

      agent.subscribe(subscriber1);
      agent.subscribe(subscriber2);
      agent.subscribe(subscriber3);

      agent.setEventsToEmit([
        { type: EventType.RUN_STARTED, threadId: "test", runId: "test" } as RunStartedEvent,
      ]);

      await agent.runAgent({});

      // Final state should reflect all mutations
      expect(agent.state).toEqual({ step: 3 });

      expect(subscriber1.onRunInitialized).toHaveBeenCalledWith(
        expect.objectContaining({
          state: { counter: 0 }, // Original state
        }),
      );

      expect(subscriber2.onRunInitialized).toHaveBeenCalledWith(
        expect.objectContaining({
          state: { step: 1 }, // Modified by subscriber1
        }),
      );

      expect(subscriber3.onRunInitialized).toHaveBeenCalledWith(
        expect.objectContaining({
          state: { step: 2 }, // Modified by subscriber2
        }),
      );
    });
  });

  describe("event-specific callbacks", () => {
    it("should call specific event callbacks with correct parameters", async () => {
      const textStartEvent: TextMessageStartEvent = {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "test-msg",
        role: "assistant",
      };

      const textContentEvent: TextMessageContentEvent = {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "test-msg",
        delta: "Hello",
      };

      const specificSubscriber: AgentSubscriber = {
        onTextMessageStartEvent: jest.fn(),
        onTextMessageContentEvent: jest.fn(),
      };

      agent.subscribe(specificSubscriber);
      agent.setEventsToEmit([textStartEvent, textContentEvent]);

      await agent.runAgent({});

      expect(specificSubscriber.onTextMessageStartEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event: textStartEvent,
          messages: [{ content: "Hello", id: "msg-1", role: "user" }], // Pre-mutation state
          state: { counter: 0 }, // Pre-mutation state
          agent,
        }),
      );

      expect(specificSubscriber.onTextMessageContentEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event: textContentEvent,
          textMessageBuffer: "", // Empty - buffer before current delta is applied
          messages: expect.arrayContaining([
            expect.objectContaining({ content: "Hello", id: "msg-1", role: "user" }),
            expect.objectContaining({ content: "", id: "test-msg", role: "assistant" }), // Message before delta applied
          ]),
          state: { counter: 0 },
          agent,
        }),
      );
    });

    it("should call generic onEvent callback for all events", async () => {
      const events: BaseEvent[] = [
        {
          type: EventType.TEXT_MESSAGE_START,
          messageId: "test-msg",
          role: "assistant",
        } as TextMessageStartEvent,
        {
          type: EventType.STATE_SNAPSHOT,
          snapshot: { test: true },
        } as StateSnapshotEvent,
      ];

      const genericSubscriber: AgentSubscriber = {
        onEvent: jest.fn(),
      };

      agent.subscribe(genericSubscriber);
      agent.setEventsToEmit(events);

      await agent.runAgent({});

      expect(genericSubscriber.onEvent).toHaveBeenCalledTimes(2);
      expect(genericSubscriber.onEvent).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          event: events[0],
        }),
      );
      expect(genericSubscriber.onEvent).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          event: events[1],
        }),
      );
    });
  });

  describe("lifecycle callbacks", () => {
    it("should call lifecycle callbacks in correct order", async () => {
      const callOrder: string[] = [];

      const lifecycleSubscriber: AgentSubscriber = {
        onRunInitialized: jest.fn().mockImplementation(() => {
          callOrder.push("initialized");
        }),
        onRunFinalized: jest.fn().mockImplementation(() => {
          callOrder.push("finalized");
        }),
      };

      agent.subscribe(lifecycleSubscriber);
      agent.setEventsToEmit([
        { type: EventType.RUN_STARTED, threadId: "test", runId: "test" } as RunStartedEvent,
      ]);

      await agent.runAgent({});

      expect(callOrder).toEqual(["initialized", "finalized"]);
    });

    it("should call onRunFinalized even after errors", async () => {
      const lifecycleSubscriber: AgentSubscriber = {
        onRunFailed: jest.fn().mockReturnValue({
          stopPropagation: true, // Handle the error
        }),
        onRunFinalized: jest.fn(),
      };

      // Create an agent that throws an error
      class ErrorAgent extends AbstractAgent {
        protected run(input: RunAgentInput): Observable<BaseEvent> {
          return from([
            {
              type: EventType.RUN_STARTED,
              threadId: input.threadId,
              runId: input.runId,
            } as RunStartedEvent,
          ]).pipe(mergeMap(() => throwError(() => new Error("Test error"))));
        }
      }

      const errorAgent = new ErrorAgent();
      errorAgent.subscribe(lifecycleSubscriber);

      await errorAgent.runAgent({});

      expect(lifecycleSubscriber.onRunFailed).toHaveBeenCalled();
      expect(lifecycleSubscriber.onRunFinalized).toHaveBeenCalled();
    });
  });

  describe("Tool Call Tests", () => {
    test("should handle tool call events with proper buffer accumulation", async () => {
      // Create agent that emits tool call sequence
      const toolCallAgent = new TestAgent();
      toolCallAgent.subscribe(mockSubscriber);
      toolCallAgent.setEventsToEmit([
        {
          type: EventType.TOOL_CALL_START,
          toolCallId: "call-123",
          toolCallName: "search",
        } as ToolCallStartEvent,
        {
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: "call-123",
          delta: '{"query": "te',
        } as ToolCallArgsEvent,
        {
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: "call-123",
          delta: 'st"}',
        } as ToolCallArgsEvent,
        {
          type: EventType.TOOL_CALL_END,
          toolCallId: "call-123",
        } as ToolCallEndEvent,
      ]);

      await toolCallAgent.runAgent({});

      // Verify tool call events were called
      expect(mockSubscriber.onToolCallStartEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event: expect.objectContaining({
            type: EventType.TOOL_CALL_START,
            toolCallId: "call-123",
            toolCallName: "search",
          }),
          messages: [],
          state: {},
          agent: toolCallAgent,
        }),
      );

      // Check buffer accumulation
      expect(mockSubscriber.onToolCallArgsEvent).toHaveBeenCalledTimes(2);

      // First call should have empty buffer (before first delta applied)
      expect(mockSubscriber.onToolCallArgsEvent).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          toolCallBuffer: "",
          toolCallName: "search",
          partialToolCallArgs: "", // Empty string when buffer is empty
        }),
      );

      // Second call should have partial buffer (before second delta applied)
      expect(mockSubscriber.onToolCallArgsEvent).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          toolCallBuffer: '{"query": "te',
          toolCallName: "search",
          partialToolCallArgs: '{"query": "te"}', // untruncateJson returns truncated JSON string
        }),
      );

      expect(mockSubscriber.onToolCallEndEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          toolCallName: "search",
          toolCallArgs: { query: "test" },
        }),
      );

      expect(mockSubscriber.onNewToolCall).toHaveBeenCalledWith(
        expect.objectContaining({
          toolCall: {
            id: "call-123",
            type: "function",
            function: {
              name: "search",
              arguments: '{"query": "test"}',
            },
          },
        }),
      );
    });
  });

  describe("Buffer Accumulation Tests", () => {
    test("should properly accumulate text message buffer", async () => {
      const textAgent = new TestAgent();
      textAgent.subscribe(mockSubscriber);
      textAgent.setEventsToEmit([
        {
          type: EventType.TEXT_MESSAGE_START,
          messageId: "msg-1",
          role: "assistant",
        } as TextMessageStartEvent,
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: "msg-1",
          delta: "Hello",
        } as TextMessageContentEvent,
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: "msg-1",
          delta: " ",
        } as TextMessageContentEvent,
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: "msg-1",
          delta: "World",
        } as TextMessageContentEvent,
        {
          type: EventType.TEXT_MESSAGE_END,
          messageId: "msg-1",
        } as TextMessageEndEvent,
      ]);

      await textAgent.runAgent({});

      // Verify buffer accumulation
      expect(mockSubscriber.onTextMessageContentEvent).toHaveBeenCalledTimes(3);

      expect(mockSubscriber.onTextMessageContentEvent).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          textMessageBuffer: "", // First event: no content accumulated yet
        }),
      );

      expect(mockSubscriber.onTextMessageContentEvent).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          textMessageBuffer: "Hello", // Second event: content from first event
        }),
      );

      expect(mockSubscriber.onTextMessageContentEvent).toHaveBeenNthCalledWith(
        3,
        expect.objectContaining({
          textMessageBuffer: "Hello ", // Third event: content from first + second events
        }),
      );

      expect(mockSubscriber.onTextMessageEndEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          textMessageBuffer: "Hello World",
        }),
      );
    });

    test("should reset text buffer on new message", async () => {
      const multiMessageAgent = new TestAgent();
      multiMessageAgent.subscribe(mockSubscriber);
      multiMessageAgent.setEventsToEmit([
        {
          type: EventType.TEXT_MESSAGE_START,
          messageId: "msg-1",
        } as TextMessageStartEvent,
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: "msg-1",
          delta: "First",
        } as TextMessageContentEvent,
        {
          type: EventType.TEXT_MESSAGE_END,
          messageId: "msg-1",
        } as TextMessageEndEvent,
        {
          type: EventType.TEXT_MESSAGE_START,
          messageId: "msg-2",
        } as TextMessageStartEvent,
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: "msg-2",
          delta: "Second",
        } as TextMessageContentEvent,
        {
          type: EventType.TEXT_MESSAGE_END,
          messageId: "msg-2",
        } as TextMessageEndEvent,
      ]);

      await multiMessageAgent.runAgent({});

      // Check first message
      expect(mockSubscriber.onTextMessageContentEvent).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          textMessageBuffer: "", // First message, first content: no content accumulated yet
        }),
      );

      // Check second message (buffer should reset)
      expect(mockSubscriber.onTextMessageContentEvent).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          textMessageBuffer: "", // Second message, first content: buffer reset, no content accumulated yet
        }),
      );
    });
  });

  describe("Message and Tool Call Lifecycle Tests", () => {
    test("should call onNewMessage after text message completion", async () => {
      const textAgent = new TestAgent();
      textAgent.subscribe(mockSubscriber);
      textAgent.setEventsToEmit([
        {
          type: EventType.TEXT_MESSAGE_START,
          messageId: "msg-1",
          role: "assistant",
        } as TextMessageStartEvent,
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: "msg-1",
          delta: "Test message",
        } as TextMessageContentEvent,
        {
          type: EventType.TEXT_MESSAGE_END,
          messageId: "msg-1",
        } as TextMessageEndEvent,
      ]);

      await textAgent.runAgent({});

      expect(mockSubscriber.onNewMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.objectContaining({
            id: "msg-1",
            role: "assistant",
            content: "Test message",
          }),
        }),
      );
    });

    test("should call onNewToolCall after tool call completion", async () => {
      const toolCallAgent = new TestAgent();
      toolCallAgent.subscribe(mockSubscriber);
      toolCallAgent.setEventsToEmit([
        {
          type: EventType.TOOL_CALL_START,
          toolCallId: "call-123",
          toolCallName: "search",
        } as ToolCallStartEvent,
        {
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: "call-123",
          delta: '{"query": "test"}',
        } as ToolCallArgsEvent,
        {
          type: EventType.TOOL_CALL_END,
          toolCallId: "call-123",
        } as ToolCallEndEvent,
      ]);

      await toolCallAgent.runAgent({});

      expect(mockSubscriber.onNewToolCall).toHaveBeenCalledWith(
        expect.objectContaining({
          toolCall: {
            id: "call-123",
            type: "function",
            function: {
              name: "search",
              arguments: '{"query": "test"}',
            },
          },
        }),
      );
    });
  });

  describe("Custom Event Tests", () => {
    test("should handle custom events", async () => {
      const customAgent = new TestAgent();
      customAgent.subscribe(mockSubscriber);
      customAgent.setEventsToEmit([
        {
          type: EventType.CUSTOM,
          name: "user_interaction",
          data: { action: "click", target: "button" },
        } as CustomEvent,
      ]);

      await customAgent.runAgent({});

      expect(mockSubscriber.onCustomEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event: expect.objectContaining({
            type: EventType.CUSTOM,
            name: "user_interaction",
            data: { action: "click", target: "button" },
          }),
          messages: [],
          state: {},
          agent: customAgent,
        }),
      );
    });
  });

  describe("Subscriber Error Handling", () => {
    test("should handle errors in subscriber callbacks gracefully", async () => {
      const errorSubscriber = {
        onEvent: jest.fn().mockImplementation(() => {
          // Return stopPropagation to handle the error gracefully
          throw new Error("Subscriber error");
        }),
        onTextMessageStartEvent: jest.fn().mockImplementation(() => {
          throw new Error("Sync subscriber error");
        }),
      };

      // Add a working subscriber to ensure others still work
      const workingSubscriber = {
        onEvent: jest.fn(),
        onTextMessageStartEvent: jest.fn(),
      };

      const testAgent = new TestAgent();
      testAgent.subscribe(errorSubscriber);
      testAgent.subscribe(workingSubscriber);
      testAgent.setEventsToEmit([
        {
          type: EventType.TEXT_MESSAGE_START,
          messageId: "msg-1",
        } as TextMessageStartEvent,
      ]);

      // Should not throw despite subscriber errors
      await expect(testAgent.runAgent({})).resolves.toBeDefined();

      expect(errorSubscriber.onEvent).toHaveBeenCalled();
      expect(errorSubscriber.onTextMessageStartEvent).toHaveBeenCalled();
      expect(workingSubscriber.onEvent).toHaveBeenCalled();
      expect(workingSubscriber.onTextMessageStartEvent).toHaveBeenCalled();
    });

    test("should continue processing other subscribers when one fails", async () => {
      const errorSubscriber = {
        onTextMessageStartEvent: jest.fn().mockImplementation(() => {
          throw new Error("First subscriber error");
        }),
      };

      const workingSubscriber = {
        onTextMessageStartEvent: jest.fn().mockResolvedValue(undefined),
      };

      const testAgent = new TestAgent();
      testAgent.subscribe(errorSubscriber);
      testAgent.subscribe(workingSubscriber);
      testAgent.setEventsToEmit([
        {
          type: EventType.TEXT_MESSAGE_START,
          messageId: "msg-1",
        } as TextMessageStartEvent,
      ]);

      await testAgent.runAgent({});

      expect(errorSubscriber.onTextMessageStartEvent).toHaveBeenCalled();
      expect(workingSubscriber.onTextMessageStartEvent).toHaveBeenCalled();
    });
  });

  describe("Realistic Event Sequences", () => {
    test("should handle a realistic conversation with mixed events", async () => {
      const realisticAgent = new TestAgent();
      realisticAgent.subscribe(mockSubscriber);
      realisticAgent.setEventsToEmit([
        {
          type: EventType.RUN_STARTED,
          runId: "run-123",
        } as RunStartedEvent,
        {
          type: EventType.TEXT_MESSAGE_START,
          messageId: "msg-1",
          role: "assistant",
        } as TextMessageStartEvent,
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: "msg-1",
          delta: "Let me search for that information.",
        } as TextMessageContentEvent,
        {
          type: EventType.TEXT_MESSAGE_END,
          messageId: "msg-1",
        } as TextMessageEndEvent,
        {
          type: EventType.TOOL_CALL_START,
          toolCallId: "call-1",
          toolCallName: "search",
        } as ToolCallStartEvent,
        {
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: "call-1",
          delta: '{"query": "weather today"}',
        } as ToolCallArgsEvent,
        {
          type: EventType.TOOL_CALL_END,
          toolCallId: "call-1",
        } as ToolCallEndEvent,
        {
          type: EventType.TOOL_CALL_RESULT,
          toolCallId: "call-1",
          content: "Sunny, 75°F",
          messageId: "result-1",
        } as ToolCallResultEvent,
        {
          type: EventType.TEXT_MESSAGE_START,
          messageId: "msg-2",
          role: "assistant",
        } as TextMessageStartEvent,
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: "msg-2",
          delta: "The weather today is sunny and 75°F.",
        } as TextMessageContentEvent,
        {
          type: EventType.TEXT_MESSAGE_END,
          messageId: "msg-2",
        } as TextMessageEndEvent,
        {
          type: EventType.STATE_SNAPSHOT,
          state: { weather: "sunny" },
        } as StateSnapshotEvent,
        {
          type: EventType.RUN_FINISHED,
          runId: "run-123",
          result: "success",
        } as RunFinishedEvent,
      ]);

      await realisticAgent.runAgent({});

      // Verify complete sequence was processed
      expect(mockSubscriber.onRunStartedEvent).toHaveBeenCalledTimes(1);
      expect(mockSubscriber.onTextMessageStartEvent).toHaveBeenCalledTimes(2);
      expect(mockSubscriber.onTextMessageEndEvent).toHaveBeenCalledTimes(2);
      expect(mockSubscriber.onToolCallStartEvent).toHaveBeenCalledTimes(1);
      expect(mockSubscriber.onToolCallEndEvent).toHaveBeenCalledTimes(1);
      expect(mockSubscriber.onToolCallResultEvent).toHaveBeenCalledTimes(1);
      expect(mockSubscriber.onStateSnapshotEvent).toHaveBeenCalledTimes(1);
      expect(mockSubscriber.onRunFinishedEvent).toHaveBeenCalledTimes(1);
      expect(mockSubscriber.onNewMessage).toHaveBeenCalledTimes(3); // 2 TEXT_MESSAGE_END + 1 TOOL_CALL_RESULT
      expect(mockSubscriber.onNewToolCall).toHaveBeenCalledTimes(1);
    });
  });

  describe("Advanced Mutation Tests", () => {
    test("should handle mutations with stopPropagation in tool call events", async () => {
      const mutatingSubscriber = {
        onToolCallStartEvent: jest.fn().mockResolvedValue({
          state: { toolCallBlocked: true },
          stopPropagation: true,
        }),
      };

      const secondSubscriber = {
        onToolCallStartEvent: jest.fn(),
      };

      const toolCallAgent = new TestAgent();
      toolCallAgent.subscribe(mutatingSubscriber);
      toolCallAgent.subscribe(secondSubscriber);
      toolCallAgent.setEventsToEmit([
        {
          type: EventType.TOOL_CALL_START,
          toolCallId: "call-123",
          toolCallName: "search",
        } as ToolCallStartEvent,
      ]);

      await toolCallAgent.runAgent({});

      expect(mutatingSubscriber.onToolCallStartEvent).toHaveBeenCalled();
      expect(secondSubscriber.onToolCallStartEvent).not.toHaveBeenCalled();
    });

    test("should accumulate mutations across multiple event types", async () => {
      let messageCount = 0;
      let stateUpdates = 0;

      const trackingSubscriber = {
        onTextMessageStartEvent: jest.fn().mockImplementation(() => {
          messageCount++;
          return { state: { messageCount } };
        }),
        onToolCallStartEvent: jest.fn().mockImplementation(() => {
          stateUpdates++;
          return { state: { stateUpdates } };
        }),
      };

      const mixedAgent = new TestAgent();
      mixedAgent.subscribe(mockSubscriber);
      mixedAgent.subscribe(trackingSubscriber);
      mixedAgent.setEventsToEmit([
        {
          type: EventType.TEXT_MESSAGE_START,
          messageId: "msg-1",
        } as TextMessageStartEvent,
        {
          type: EventType.TOOL_CALL_START,
          toolCallId: "call-1",
          toolCallName: "search",
        } as ToolCallStartEvent,
        {
          type: EventType.TEXT_MESSAGE_START,
          messageId: "msg-2",
        } as TextMessageStartEvent,
      ]);

      await mixedAgent.runAgent({});

      expect(trackingSubscriber.onTextMessageStartEvent).toHaveBeenCalledTimes(2);
      expect(trackingSubscriber.onToolCallStartEvent).toHaveBeenCalledTimes(1);
    });
  });

  describe("EmptyError Bug Reproduction", () => {
    test("should demonstrate EmptyError with STEP_STARTED/STEP_FINISHED events that cause no mutations", async () => {
      const emptyAgent = new TestAgent();

      // No subscribers that return mutations
      emptyAgent.setEventsToEmit([
        {
          type: EventType.RUN_STARTED,
          runId: "run-123",
        } as RunStartedEvent,
        {
          type: EventType.STEP_STARTED,
          stepName: "step-1",
        } as StepStartedEvent,
        {
          type: EventType.STEP_FINISHED,
          stepName: "step-1",
        } as StepFinishedEvent,
        {
          type: EventType.RUN_FINISHED,
          runId: "run-123",
        } as RunFinishedEvent,
      ]);

      // This should throw EmptyError because:
      // 1. STEP_STARTED and STEP_FINISHED have no default behavior (don't modify messages/state)
      // 2. No subscribers return mutations
      // 3. ALL calls to emitUpdates() return EMPTY
      // 4. Observable completes without emitting anything
      await expect(emptyAgent.runAgent({}));
    });
  });
});

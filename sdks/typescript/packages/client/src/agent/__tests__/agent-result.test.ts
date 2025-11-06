import { AbstractAgent } from "../agent";
import { AgentSubscriber } from "../subscriber";
import {
  BaseEvent,
  EventType,
  Message,
  RunAgentInput,
  State,
  MessagesSnapshotEvent,
  RunFinishedEvent,
  RunStartedEvent,
} from "@ag-ui/core";
import { Observable, of } from "rxjs";

// Mock uuid module
jest.mock("uuid", () => ({
  v4: jest.fn().mockReturnValue("mock-uuid"),
}));

// Mock utils
jest.mock("@/utils", () => ({
  structuredClone_: (obj: any) => {
    if (obj === undefined) return undefined;
    const jsonString = JSON.stringify(obj);
    if (jsonString === undefined || jsonString === "undefined") return undefined;
    return JSON.parse(jsonString);
  },
}));

// Mock the verify and chunks modules
jest.mock("@/verify", () => ({
  verifyEvents: jest.fn(() => (source$: Observable<any>) => source$),
}));

jest.mock("@/chunks", () => ({
  transformChunks: jest.fn(() => (source$: Observable<any>) => source$),
}));

// Helper function to wait for async notifications to complete
const waitForAsyncNotifications = async () => {
  await new Promise((resolve) => setImmediate(resolve));
};

// Create a test agent implementation that can emit specific events
class TestAgent extends AbstractAgent {
  private eventsToEmit: BaseEvent[] = [];

  setEventsToEmit(events: BaseEvent[]) {
    this.eventsToEmit = events;
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    return of(...this.eventsToEmit);
  }
}

describe("Agent Result", () => {
  let agent: TestAgent;

  beforeEach(() => {
    jest.clearAllMocks();

    agent = new TestAgent({
      threadId: "test-thread",
      initialMessages: [
        {
          id: "existing-msg-1",
          role: "user",
          content: "Existing message 1",
        },
        {
          id: "existing-msg-2",
          role: "assistant",
          content: "Existing message 2",
        },
      ],
      initialState: { counter: 0 },
    });
  });

  describe("result handling", () => {
    it("should return undefined result when no result is set", async () => {
      agent.setEventsToEmit([
        {
          type: EventType.RUN_STARTED,
          threadId: "test-thread",
          runId: "test-run",
        } as RunStartedEvent,
      ]);

      const result = await agent.runAgent();

      expect(result.result).toBeUndefined();
      expect(result.newMessages).toEqual([]);
    });

    it("should return result set by onRunFinishedEvent", async () => {
      const expectedResult = { success: true, data: "test-data", count: 42 };

      agent.setEventsToEmit([
        {
          type: EventType.RUN_STARTED,
          threadId: "test-thread",
          runId: "test-run",
        } as RunStartedEvent,
        {
          type: EventType.RUN_FINISHED,
          threadId: "test-thread",
          runId: "test-run",
          result: expectedResult,
        } as RunFinishedEvent,
      ]);

      const result = await agent.runAgent();

      expect(result.result).toEqual(expectedResult);
      expect(result.newMessages).toEqual([]);
    });

    it("should handle string result", async () => {
      const expectedResult = "Simple string result";

      agent.setEventsToEmit([
        {
          type: EventType.RUN_FINISHED,
          threadId: "test-thread",
          runId: "test-run",
          result: expectedResult,
        } as RunFinishedEvent,
      ]);

      const result = await agent.runAgent();

      expect(result.result).toBe(expectedResult);
    });

    it("should handle null result", async () => {
      agent.setEventsToEmit([
        {
          type: EventType.RUN_FINISHED,
          threadId: "test-thread",
          runId: "test-run",
          result: null,
        } as RunFinishedEvent,
      ]);

      const result = await agent.runAgent();

      expect(result.result).toBeNull();
    });
  });

  describe("newMessages tracking", () => {
    it("should track new messages added during run", async () => {
      const newMessages: Message[] = [
        {
          id: "new-msg-1",
          role: "user",
          content: "New message 1",
        },
        {
          id: "new-msg-2",
          role: "assistant",
          content: "New message 2",
        },
      ];

      const allMessages = [...agent.messages, ...newMessages];

      agent.setEventsToEmit([
        {
          type: EventType.MESSAGES_SNAPSHOT,
          messages: allMessages,
        } as MessagesSnapshotEvent,
        {
          type: EventType.RUN_FINISHED,
          threadId: "test-thread",
          runId: "test-run",
          result: "success",
        } as RunFinishedEvent,
      ]);

      const result = await agent.runAgent();

      expect(result.result).toBe("success");
      expect(result.newMessages).toEqual(newMessages);
      expect(agent.messages).toEqual(allMessages);
    });

    it("should not include existing messages in newMessages", async () => {
      const newMessage: Message = {
        id: "new-msg-only",
        role: "assistant",
        content: "Only this is new",
      };

      // Include existing messages plus new one
      const allMessages = [...agent.messages, newMessage];

      agent.setEventsToEmit([
        {
          type: EventType.MESSAGES_SNAPSHOT,
          messages: allMessages,
        } as MessagesSnapshotEvent,
      ]);

      const result = await agent.runAgent();

      expect(result.newMessages).toEqual([newMessage]);
      expect(result.newMessages).toHaveLength(1);
      expect(agent.messages).toEqual(allMessages);
    });

    it("should handle no new messages", async () => {
      // Keep same messages as initial
      agent.setEventsToEmit([
        {
          type: EventType.MESSAGES_SNAPSHOT,
          messages: agent.messages,
        } as MessagesSnapshotEvent,
      ]);

      const result = await agent.runAgent();

      expect(result.newMessages).toEqual([]);
      expect(agent.messages).toHaveLength(2); // Original messages
    });

    it("should handle multiple new messages with tool calls", async () => {
      const newMessages: Message[] = [
        {
          id: "new-msg-user",
          role: "user",
          content: "User query",
        },
        {
          id: "new-msg-assistant",
          role: "assistant",
          content: "Let me help you",
          toolCalls: [
            {
              id: "call-1",
              type: "function",
              function: {
                name: "search_tool",
                arguments: '{"query": "test"}',
              },
            },
          ],
        },
        {
          id: "new-msg-tool",
          role: "tool",
          content: "Tool result",
          toolCallId: "call-1",
        },
        {
          id: "new-msg-final",
          role: "assistant",
          content: "Here's the answer",
        },
      ];

      const allMessages = [...agent.messages, ...newMessages];

      agent.setEventsToEmit([
        {
          type: EventType.MESSAGES_SNAPSHOT,
          messages: allMessages,
        } as MessagesSnapshotEvent,
        {
          type: EventType.RUN_FINISHED,
          threadId: "test-thread",
          runId: "test-run",
          result: { toolsUsed: 1, messagesAdded: 4 },
        } as RunFinishedEvent,
      ]);

      const result = await agent.runAgent();

      expect(result.newMessages).toEqual(newMessages);
      expect(result.newMessages).toHaveLength(4);
      expect(result.result).toEqual({ toolsUsed: 1, messagesAdded: 4 });
    });

    it("should preserve message order", async () => {
      const newMessages: Message[] = [
        { id: "new-1", role: "user", content: "First new" },
        { id: "new-2", role: "assistant", content: "Second new" },
        { id: "new-3", role: "user", content: "Third new" },
      ];

      const allMessages = [...agent.messages, ...newMessages];

      agent.setEventsToEmit([
        {
          type: EventType.MESSAGES_SNAPSHOT,
          messages: allMessages,
        } as MessagesSnapshotEvent,
      ]);

      const result = await agent.runAgent();

      expect(result.newMessages).toEqual(newMessages);
      // Verify order is preserved
      expect(result.newMessages[0].id).toBe("new-1");
      expect(result.newMessages[1].id).toBe("new-2");
      expect(result.newMessages[2].id).toBe("new-3");
    });
  });

  describe("combined result and newMessages", () => {
    it("should return both result and newMessages correctly", async () => {
      const newMessages: Message[] = [
        {
          id: "conversation-msg",
          role: "assistant",
          content: "Here's what I found",
        },
      ];

      const expectedResult = {
        status: "completed",
        messagesGenerated: 1,
        processingTime: 1500,
      };

      const allMessages = [...agent.messages, ...newMessages];

      agent.setEventsToEmit([
        {
          type: EventType.MESSAGES_SNAPSHOT,
          messages: allMessages,
        } as MessagesSnapshotEvent,
        {
          type: EventType.RUN_FINISHED,
          threadId: "test-thread",
          runId: "test-run",
          result: expectedResult,
        } as RunFinishedEvent,
      ]);

      const result = await agent.runAgent();

      expect(result.result).toEqual(expectedResult);
      expect(result.newMessages).toEqual(newMessages);
      expect(result.newMessages).toHaveLength(1);
    });

    it("should handle empty newMessages with valid result", async () => {
      const expectedResult = { error: false, processed: true };

      agent.setEventsToEmit([
        {
          type: EventType.RUN_FINISHED,
          threadId: "test-thread",
          runId: "test-run",
          result: expectedResult,
        } as RunFinishedEvent,
      ]);

      const result = await agent.runAgent();

      expect(result.result).toEqual(expectedResult);
      expect(result.newMessages).toEqual([]);
    });
  });

  describe("subscriber notifications integration", () => {
    it("should track newMessages without interfering with existing event processing", async () => {
      const mockSubscriber: AgentSubscriber = {
        onNewMessage: jest.fn(),
        onMessagesChanged: jest.fn(),
        onNewToolCall: jest.fn(),
      };

      agent.subscribe(mockSubscriber);

      const newMessages: Message[] = [
        {
          id: "new-msg-1",
          role: "user",
          content: "New user message",
        },
        {
          id: "new-msg-2",
          role: "assistant",
          content: "New assistant message",
          toolCalls: [
            {
              id: "call-1",
              type: "function",
              function: { name: "test_tool", arguments: "{}" },
            },
          ],
        },
      ];

      const allMessages = [...agent.messages, ...newMessages];

      agent.setEventsToEmit([
        {
          type: EventType.MESSAGES_SNAPSHOT,
          messages: allMessages,
        } as MessagesSnapshotEvent,
      ]);

      const result = await agent.runAgent();

      expect(result.newMessages).toEqual(newMessages);

      // Note: Subscriber notifications are handled by the existing event processing pipeline
      // The newMessages tracking is separate from subscriber notification logic
    });

    it("should return empty newMessages when no messages are added", async () => {
      const mockSubscriber: AgentSubscriber = {
        onNewMessage: jest.fn(),
        onMessagesChanged: jest.fn(),
        onNewToolCall: jest.fn(),
      };

      agent.subscribe(mockSubscriber);

      agent.setEventsToEmit([
        {
          type: EventType.RUN_FINISHED,
          threadId: "test-thread",
          runId: "test-run",
          result: "no new messages",
        } as RunFinishedEvent,
      ]);

      const result = await agent.runAgent();

      expect(result.newMessages).toEqual([]);

      // Should not fire any new message events since no messages were added
      expect(mockSubscriber.onNewMessage).not.toHaveBeenCalled();
      expect(mockSubscriber.onNewToolCall).not.toHaveBeenCalled();
      expect(mockSubscriber.onMessagesChanged).not.toHaveBeenCalled();
    });
  });

  describe("edge cases", () => {
    it("should handle agent with no initial messages", async () => {
      const emptyAgent = new TestAgent({
        threadId: "empty-thread",
        initialMessages: [],
      });

      const newMessages: Message[] = [{ id: "first-ever", role: "user", content: "First message" }];

      emptyAgent.setEventsToEmit([
        {
          type: EventType.MESSAGES_SNAPSHOT,
          messages: newMessages,
        } as MessagesSnapshotEvent,
      ]);

      const result = await emptyAgent.runAgent();

      expect(result.newMessages).toEqual(newMessages);
      expect(emptyAgent.messages).toEqual(newMessages);
    });

    it("should handle messages with duplicate IDs correctly", async () => {
      // This tests that we're using Set correctly for ID tracking
      const messageWithSameId: Message = {
        id: "existing-msg-1", // Same ID as existing message
        role: "user",
        content: "Updated content",
      };

      const allMessages = [...agent.messages, messageWithSameId];

      agent.setEventsToEmit([
        {
          type: EventType.MESSAGES_SNAPSHOT,
          messages: allMessages,
        } as MessagesSnapshotEvent,
      ]);

      const result = await agent.runAgent();

      // Should not include the duplicate ID in newMessages
      expect(result.newMessages).toEqual([]);
      expect(agent.messages).toEqual(allMessages);
    });

    it("should handle complex result objects", async () => {
      const complexResult = {
        metadata: {
          timestamp: new Date().toISOString(),
          version: "1.0.0",
        },
        data: {
          results: [1, 2, 3],
          nested: {
            deep: {
              value: "test",
            },
          },
        },
        stats: {
          processingTime: 1000,
          tokensUsed: 150,
        },
      };

      agent.setEventsToEmit([
        {
          type: EventType.RUN_FINISHED,
          threadId: "test-thread",
          runId: "test-run",
          result: complexResult,
        } as RunFinishedEvent,
      ]);

      const result = await agent.runAgent();

      expect(result.result).toEqual(complexResult);
      expect(result.result).toMatchObject(complexResult);
    });
  });
});

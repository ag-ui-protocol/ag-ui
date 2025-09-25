import { Middleware, EventWithState } from "../middleware";
import { AbstractAgent } from "@/agent";
import {
  RunAgentInput,
  BaseEvent,
  EventType,
  TextMessageStartEvent,
  TextMessageContentEvent,
  StateSnapshotEvent,
  StateDeltaEvent,
  MessagesSnapshotEvent,
  ToolCallStartEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
} from "@ag-ui/core";
import { Observable, from } from "rxjs";
import { map, toArray } from "rxjs/operators";

// Mock agent for testing
class MockAgent extends AbstractAgent {
  constructor(private events: BaseEvent[]) {
    super();
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    return from(this.events);
  }
}

// Test middleware that uses runNextWithState
class TestMiddleware extends Middleware {
  run(input: RunAgentInput, next: AbstractAgent): Observable<BaseEvent> {
    return this.runNextWithState(input, next).pipe(
      map(({ event }) => event)
    );
  }

  // Expose for testing
  testRunNextWithState(
    input: RunAgentInput,
    next: AbstractAgent
  ): Observable<EventWithState> {
    return this.runNextWithState(input, next);
  }
}

describe("Middleware.runNextWithState", () => {
  it("should track messages as they are built", async () => {
    const events: BaseEvent[] = [
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "msg1",
        role: "assistant",
      } as TextMessageStartEvent,
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "msg1",
        delta: "Hello",
      } as TextMessageContentEvent,
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "msg1",
        delta: " world",
      } as TextMessageContentEvent,
    ];

    const agent = new MockAgent(events);
    const middleware = new TestMiddleware();
    const input: RunAgentInput = { messages: [], state: {} };

    const results = await middleware
      .testRunNextWithState(input, agent)
      .pipe(toArray())
      .toPromise();

    expect(results).toHaveLength(3);

    // After TEXT_MESSAGE_START, should have one empty message
    expect(results![0].messages).toHaveLength(1);
    expect(results![0].messages[0].id).toBe("msg1");
    expect(results![0].messages[0].role).toBe("assistant");
    expect(results![0].messages[0].content).toBe("");

    // After first content chunk
    expect(results![1].messages).toHaveLength(1);
    expect(results![1].messages[0].content).toBe("Hello");

    // After second content chunk
    expect(results![2].messages).toHaveLength(1);
    expect(results![2].messages[0].content).toBe("Hello world");
  });

  it("should track state changes", async () => {
    const events: BaseEvent[] = [
      {
        type: EventType.STATE_SNAPSHOT,
        snapshot: { counter: 0, name: "test" },
      } as StateSnapshotEvent,
      {
        type: EventType.STATE_DELTA,
        delta: [{ op: "replace", path: "/counter", value: 1 }],
      } as StateDeltaEvent,
      {
        type: EventType.STATE_DELTA,
        delta: [{ op: "add", path: "/newField", value: "added" }],
      } as StateDeltaEvent,
    ];

    const agent = new MockAgent(events);
    const middleware = new TestMiddleware();
    const input: RunAgentInput = { messages: [], state: {} };

    const results = await middleware
      .testRunNextWithState(input, agent)
      .pipe(toArray())
      .toPromise();

    expect(results).toHaveLength(3);

    // After STATE_SNAPSHOT
    expect(results![0].state).toEqual({ counter: 0, name: "test" });

    // After first STATE_DELTA
    expect(results![1].state).toEqual({ counter: 1, name: "test" });

    // After second STATE_DELTA
    expect(results![2].state).toEqual({
      counter: 1,
      name: "test",
      newField: "added",
    });
  });

  it("should handle MESSAGES_SNAPSHOT", async () => {
    const events: BaseEvent[] = [
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "msg1",
        role: "user",
      } as TextMessageStartEvent,
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "msg1",
        delta: "First",
      } as TextMessageContentEvent,
      {
        type: EventType.MESSAGES_SNAPSHOT,
        messages: [
          { id: "old1", role: "assistant", content: "Previous message" },
          { id: "old2", role: "user", content: "Another message" },
        ],
      } as MessagesSnapshotEvent,
    ];

    const agent = new MockAgent(events);
    const middleware = new TestMiddleware();
    const input: RunAgentInput = { messages: [], state: {} };

    const results = await middleware
      .testRunNextWithState(input, agent)
      .pipe(toArray())
      .toPromise();

    expect(results).toHaveLength(3);

    // After building a message
    expect(results![1].messages).toHaveLength(1);
    expect(results![1].messages[0].content).toBe("First");

    // After MESSAGES_SNAPSHOT - replaces all messages
    expect(results![2].messages).toHaveLength(2);
    expect(results![2].messages[0].id).toBe("old1");
    expect(results![2].messages[1].id).toBe("old2");
  });

  it("should track tool calls", async () => {
    const events: BaseEvent[] = [
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "tool1",
        toolCallName: "calculator",
        parentMessageId: "msg1",
      } as ToolCallStartEvent,
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "tool1",
        delta: '{"operation": "add"',
      } as ToolCallArgsEvent,
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "tool1",
        delta: ', "values": [1, 2]}',
      } as ToolCallArgsEvent,
      {
        type: EventType.TOOL_CALL_END,
        toolCallId: "tool1",
      } as ToolCallEndEvent,
    ];

    const agent = new MockAgent(events);
    const middleware = new TestMiddleware();
    const input: RunAgentInput = { messages: [], state: {} };

    const results = await middleware
      .testRunNextWithState(input, agent)
      .pipe(toArray())
      .toPromise();

    expect(results).toHaveLength(4);

    // After TOOL_CALL_START
    expect(results![0].messages).toHaveLength(1);
    expect(results![0].messages[0].role).toBe("assistant");
    const msg1 = results![0].messages[0] as any;
    expect(msg1.toolCalls).toHaveLength(1);
    expect(msg1.toolCalls[0].id).toBe("tool1");
    expect(msg1.toolCalls[0].type).toBe("function");
    expect(msg1.toolCalls[0].function.name).toBe("calculator");

    // After args accumulation
    const msg3 = results![2].messages[0] as any;
    expect(msg3.toolCalls[0].function.arguments).toBe('{"operation": "add", "values": [1, 2]}');

    // After TOOL_CALL_END - args remain as string (defaultApplyEvents doesn't parse them)
    const msg4 = results![3].messages[0] as any;
    expect(msg4.toolCalls[0].function.arguments).toBe('{"operation": "add", "values": [1, 2]}');
  });

  it("should preserve initial state and messages", async () => {
    const events: BaseEvent[] = [
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "new1",
        role: "assistant",
      } as TextMessageStartEvent,
      {
        type: EventType.STATE_DELTA,
        delta: [{ op: "add", path: "/newField", value: 42 }],
      } as StateDeltaEvent,
    ];

    const agent = new MockAgent(events);
    const middleware = new TestMiddleware();

    const input: RunAgentInput = {
      messages: [
        { id: "existing1", role: "user", content: "Existing message" },
      ],
      state: { existingField: "hello" },
    };

    const results = await middleware
      .testRunNextWithState(input, agent)
      .pipe(toArray())
      .toPromise();

    expect(results).toHaveLength(2);

    // Should preserve existing message and add new one
    expect(results![0].messages).toHaveLength(2);
    expect(results![0].messages[0].id).toBe("existing1");
    expect(results![0].messages[1].id).toBe("new1");

    // Should preserve existing state and add new field
    expect(results![1].state).toEqual({
      existingField: "hello",
      newField: 42,
    });
  });

  it("should provide immutable snapshots", async () => {
    const events: BaseEvent[] = [
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "msg1",
        role: "assistant",
      } as TextMessageStartEvent,
      {
        type: EventType.STATE_SNAPSHOT,
        snapshot: { value: 1 },
      } as StateSnapshotEvent,
    ];

    const agent = new MockAgent(events);
    const middleware = new TestMiddleware();
    const input: RunAgentInput = { messages: [], state: {} };

    const results = await middleware
      .testRunNextWithState(input, agent)
      .pipe(toArray())
      .toPromise();

    // Modify returned state/messages - should not affect next results
    results![0].messages[0].content = "MODIFIED";
    results![0].state.hacked = true;

    // Second result should not be affected
    expect(results![1].messages[0].content).toBe("");
    expect(results![1].state).toEqual({ value: 1 });
    expect(results![1].state.hacked).toBeUndefined();
  });
});
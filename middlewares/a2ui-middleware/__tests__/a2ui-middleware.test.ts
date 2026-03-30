import { describe, it, expect } from "vitest";
import {
  AbstractAgent,
  BaseEvent,
  EventType,
  RunAgentInput,
  Tool,
  AssistantMessage,
  ToolMessage,
} from "@ag-ui/client";
import { Observable, firstValueFrom, toArray } from "rxjs";

import {
  A2UIMiddleware,
  A2UIActivityType,
  RENDER_A2UI_TOOL_NAME,
  LOG_A2UI_EVENT_TOOL_NAME,
  extractSurfaceIds,
  tryParseA2UIOperations,
} from "../src/index";

/**
 * Mock Agent for testing middleware
 */
class MockAgent extends AbstractAgent {
  private events: BaseEvent[];
  public runCalls: RunAgentInput[] = [];

  constructor(events: BaseEvent[] = []) {
    super();
    this.events = events;
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    this.runCalls.push(input);
    return new Observable((subscriber) => {
      for (const event of this.events) {
        subscriber.next(event);
      }
      subscriber.complete();
    });
  }

  setEvents(events: BaseEvent[]): void {
    this.events = events;
  }
}

/**
 * Create a basic RunAgentInput for testing
 */
function createRunAgentInput(overrides: Partial<RunAgentInput> = {}): RunAgentInput {
  return {
    threadId: "test-thread",
    runId: "test-run",
    tools: [],
    context: [],
    forwardedProps: {},
    state: {},
    messages: [],
    ...overrides,
  };
}

/**
 * Collect all events from an Observable
 */
async function collectEvents(observable: Observable<BaseEvent>): Promise<BaseEvent[]> {
  return firstValueFrom(observable.pipe(toArray()));
}

describe("A2UIMiddleware", () => {
  describe("tool injection", () => {
    it("should inject render_a2ui tool when injectA2UITool is true", async () => {
      const middleware = new A2UIMiddleware({ injectA2UITool: true });
      const mockAgent = new MockAgent([
        { type: EventType.RUN_STARTED, runId: "test", threadId: "test" },
        { type: EventType.RUN_FINISHED, runId: "test", threadId: "test" },
      ]);

      const input = createRunAgentInput();
      await collectEvents(middleware.run(input, mockAgent));

      expect(mockAgent.runCalls).toHaveLength(1);
      const tools = mockAgent.runCalls[0].tools;
      expect(tools.some((t) => t.name === RENDER_A2UI_TOOL_NAME)).toBe(true);
    });

    it("should not inject tool by default", async () => {
      const middleware = new A2UIMiddleware();
      const mockAgent = new MockAgent([
        { type: EventType.RUN_STARTED, runId: "test", threadId: "test" },
        { type: EventType.RUN_FINISHED, runId: "test", threadId: "test" },
      ]);

      const input = createRunAgentInput();
      await collectEvents(middleware.run(input, mockAgent));

      expect(mockAgent.runCalls).toHaveLength(1);
      const tools = mockAgent.runCalls[0].tools;
      expect(tools.some((t) => t.name === RENDER_A2UI_TOOL_NAME)).toBe(false);
    });

    it("should not duplicate tool if already present", async () => {
      const middleware = new A2UIMiddleware({ injectA2UITool: true });
      const mockAgent = new MockAgent([
        { type: EventType.RUN_STARTED, runId: "test", threadId: "test" },
        { type: EventType.RUN_FINISHED, runId: "test", threadId: "test" },
      ]);

      const existingTool: Tool = {
        name: RENDER_A2UI_TOOL_NAME,
        description: "Existing tool",
        parameters: {},
      };

      const input = createRunAgentInput({ tools: [existingTool] });
      await collectEvents(middleware.run(input, mockAgent));

      const tools = mockAgent.runCalls[0].tools;
      const matchingTools = tools.filter((t) => t.name === RENDER_A2UI_TOOL_NAME);
      expect(matchingTools).toHaveLength(1);
    });
  });

  describe("user action processing", () => {
    it("should prepend synthetic messages for user action", async () => {
      const middleware = new A2UIMiddleware();
      const mockAgent = new MockAgent([
        { type: EventType.RUN_STARTED, runId: "test", threadId: "test" },
        { type: EventType.RUN_FINISHED, runId: "test", threadId: "test" },
      ]);

      const input = createRunAgentInput({
        forwardedProps: {
          a2uiAction: {
            userAction: {
              name: "book_restaurant",
              surfaceId: "restaurant-card",
              sourceComponentId: "book-btn",
              context: { restaurantName: "Xi'an Famous Foods" },
            },
          },
        },
      });

      await collectEvents(middleware.run(input, mockAgent));

      const messages = mockAgent.runCalls[0].messages;
      expect(messages.length).toBe(2);

      // First message should be assistant with tool call
      const assistantMsg = messages[0] as AssistantMessage;
      expect(assistantMsg.role).toBe("assistant");
      expect(assistantMsg.toolCalls).toHaveLength(1);
      expect(assistantMsg.toolCalls![0].function.name).toBe(LOG_A2UI_EVENT_TOOL_NAME);

      // Second message should be tool result
      const toolMsg = messages[1] as ToolMessage;
      expect(toolMsg.role).toBe("tool");
      expect(toolMsg.content).toContain("book_restaurant");
      expect(toolMsg.content).toContain("restaurant-card");
    });

    it("should not modify messages when no user action present", async () => {
      const middleware = new A2UIMiddleware();
      const mockAgent = new MockAgent([
        { type: EventType.RUN_STARTED, runId: "test", threadId: "test" },
        { type: EventType.RUN_FINISHED, runId: "test", threadId: "test" },
      ]);

      const input = createRunAgentInput();
      await collectEvents(middleware.run(input, mockAgent));

      expect(mockAgent.runCalls[0].messages).toHaveLength(0);
    });
  });

  describe("tool call interception", () => {
    it("should emit ACTIVITY_SNAPSHOT for render_a2ui via streaming and TOOL_CALL_RESULT at RUN_FINISHED", async () => {
      const middleware = new A2UIMiddleware();
      const toolCallId = "tc-123";

      // render_a2ui uses structured args: surfaceId, components, items
      const structuredArgs = JSON.stringify({
        surfaceId: "test-surface",
        catalogId: "basic",
        components: [
          { id: "root", component: "Text", text: "Hello" },
        ],
        items: [],
      });

      const mockAgent = new MockAgent([
        { type: EventType.RUN_STARTED, runId: "test", threadId: "test" },
        {
          type: EventType.TOOL_CALL_START,
          toolCallId,
          toolCallName: "render_a2ui",
        },
        {
          type: EventType.TOOL_CALL_ARGS,
          toolCallId,
          delta: structuredArgs,
        },
        { type: EventType.TOOL_CALL_END, toolCallId },
        { type: EventType.RUN_FINISHED, runId: "test", threadId: "test" },
      ]);

      const input = createRunAgentInput();
      const events = await collectEvents(middleware.run(input, mockAgent));

      // Streaming handler should have emitted ACTIVITY_SNAPSHOT during TOOL_CALL_ARGS
      const activityEvent = events.find(
        (e) => e.type === EventType.ACTIVITY_SNAPSHOT
      );
      expect(activityEvent).toBeDefined();
      expect((activityEvent as any).activityType).toBe(A2UIActivityType);
      // Should have createSurface + updateComponents (first emission)
      const ops = (activityEvent as any).content.a2ui_operations;
      expect(ops.length).toBeGreaterThanOrEqual(2);

      // Synthetic TOOL_CALL_RESULT emitted at RUN_FINISHED
      const resultEvent = events.find((e) => e.type === EventType.TOOL_CALL_RESULT);
      expect(resultEvent).toBeDefined();
      expect((resultEvent as any).toolCallId).toBe(toolCallId);
    });

    it("should pass through events for other tools", async () => {
      const middleware = new A2UIMiddleware();
      const toolCallId = "tc-other";

      const mockAgent = new MockAgent([
        { type: EventType.RUN_STARTED, runId: "test", threadId: "test" },
        {
          type: EventType.TOOL_CALL_START,
          toolCallId,
          toolCallName: "other_tool",
        },
        {
          type: EventType.TOOL_CALL_ARGS,
          toolCallId,
          delta: '{"arg": "value"}',
        },
        { type: EventType.TOOL_CALL_END, toolCallId },
        { type: EventType.RUN_FINISHED, runId: "test", threadId: "test" },
      ]);

      const input = createRunAgentInput();
      const events = await collectEvents(middleware.run(input, mockAgent));

      // Should NOT have ACTIVITY_SNAPSHOT for other tools
      const activityEvent = events.find(
        (e) => e.type === EventType.ACTIVITY_SNAPSHOT
      );
      expect(activityEvent).toBeUndefined();

      // Should NOT have TOOL_CALL_RESULT (middleware doesn't emit for other tools)
      const resultEvent = events.find((e) => e.type === EventType.TOOL_CALL_RESULT);
      expect(resultEvent).toBeUndefined();
    });

    it("should handle streaming args deltas for render_a2ui", async () => {
      const middleware = new A2UIMiddleware();
      const toolCallId = "tc-streaming";

      // Structured args split into multiple deltas
      const fullArgs = JSON.stringify({
        surfaceId: "s1",
        catalogId: "basic",
        components: [
          { id: "root", component: "Text", text: "Hello" },
        ],
        items: [],
      });

      const mockAgent = new MockAgent([
        { type: EventType.RUN_STARTED, runId: "test", threadId: "test" },
        {
          type: EventType.TOOL_CALL_START,
          toolCallId,
          toolCallName: "render_a2ui",
        },
        {
          type: EventType.TOOL_CALL_ARGS,
          toolCallId,
          delta: fullArgs.substring(0, 20),
        },
        {
          type: EventType.TOOL_CALL_ARGS,
          toolCallId,
          delta: fullArgs.substring(20, 50),
        },
        {
          type: EventType.TOOL_CALL_ARGS,
          toolCallId,
          delta: fullArgs.substring(50),
        },
        { type: EventType.TOOL_CALL_END, toolCallId },
        { type: EventType.RUN_FINISHED, runId: "test", threadId: "test" },
      ]);

      const input = createRunAgentInput();
      const events = await collectEvents(middleware.run(input, mockAgent));

      const activityEvent = events.find(
        (e) => e.type === EventType.ACTIVITY_SNAPSHOT
      );
      expect(activityEvent).toBeDefined();
      // Should have the surface ops
      const ops = (activityEvent as any).content.a2ui_operations;
      expect(ops.length).toBeGreaterThanOrEqual(2);
    });

    it("should produce distinct messageIds for different render_a2ui calls with the same surfaceId", async () => {
      const middleware = new A2UIMiddleware();
      const toolCallId1 = "tc-first";
      const toolCallId2 = "tc-second";

      const args1 = JSON.stringify({
        surfaceId: "shared-surface",
        catalogId: "basic",
        components: [{ id: "root", component: "Text", text: "First" }],
        items: [],
      });
      const args2 = JSON.stringify({
        surfaceId: "shared-surface",
        catalogId: "basic",
        components: [{ id: "root", component: "Text", text: "Second" }],
        items: [],
      });

      const mockAgent = new MockAgent([
        { type: EventType.RUN_STARTED, runId: "test", threadId: "test" },
        // First tool call
        {
          type: EventType.TOOL_CALL_START,
          toolCallId: toolCallId1,
          toolCallName: "render_a2ui",
        },
        {
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: toolCallId1,
          delta: args1,
        },
        { type: EventType.TOOL_CALL_END, toolCallId: toolCallId1 },
        // Second tool call (same surfaceId, different toolCallId)
        {
          type: EventType.TOOL_CALL_START,
          toolCallId: toolCallId2,
          toolCallName: "render_a2ui",
        },
        {
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: toolCallId2,
          delta: args2,
        },
        { type: EventType.TOOL_CALL_END, toolCallId: toolCallId2 },
        { type: EventType.RUN_FINISHED, runId: "test", threadId: "test" },
      ]);

      const input = createRunAgentInput();
      const events = await collectEvents(middleware.run(input, mockAgent));

      // Should have two distinct ACTIVITY_SNAPSHOT events with different messageIds
      const snapshots = events.filter((e) => e.type === EventType.ACTIVITY_SNAPSHOT);
      expect(snapshots).toHaveLength(2);

      const messageId1 = (snapshots[0] as any).messageId;
      const messageId2 = (snapshots[1] as any).messageId;
      expect(messageId1).not.toBe(messageId2);

      // Both should include the surfaceId
      expect(messageId1).toContain("shared-surface");
      expect(messageId2).toContain("shared-surface");

      // Each should include its own toolCallId
      expect(messageId1).toContain(toolCallId1);
      expect(messageId2).toContain(toolCallId2);
    });

    it("should produce distinct messageIds for auto-detected A2UI in different tool results", async () => {
      const middleware = new A2UIMiddleware();
      const toolCallId1 = "tc-auto-1";
      const toolCallId2 = "tc-auto-2";

      const a2uiResult = JSON.stringify({
        a2ui_operations: [
          { version: "v0.9", createSurface: { surfaceId: "shared-surface", catalogId: "basic" } },
          { version: "v0.9", updateComponents: { surfaceId: "shared-surface", components: [{ id: "root", component: "Text", text: "Hi" }] } },
        ],
      });

      const mockAgent = new MockAgent([
        { type: EventType.RUN_STARTED, runId: "test", threadId: "test" },
        // First tool call
        {
          type: EventType.TOOL_CALL_START,
          toolCallId: toolCallId1,
          toolCallName: "render_flights",
        },
        {
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: toolCallId1,
          delta: '{}',
        },
        { type: EventType.TOOL_CALL_END, toolCallId: toolCallId1 },
        {
          type: EventType.TOOL_CALL_RESULT,
          messageId: "msg-1",
          toolCallId: toolCallId1,
          content: a2uiResult,
        },
        // Second tool call (same tool, same surfaceId, different toolCallId)
        {
          type: EventType.TOOL_CALL_START,
          toolCallId: toolCallId2,
          toolCallName: "render_flights",
        },
        {
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: toolCallId2,
          delta: '{}',
        },
        { type: EventType.TOOL_CALL_END, toolCallId: toolCallId2 },
        {
          type: EventType.TOOL_CALL_RESULT,
          messageId: "msg-2",
          toolCallId: toolCallId2,
          content: a2uiResult,
        },
        { type: EventType.RUN_FINISHED, runId: "test", threadId: "test" },
      ]);

      const input = createRunAgentInput();
      const events = await collectEvents(middleware.run(input, mockAgent));

      const snapshots = events.filter((e) => e.type === EventType.ACTIVITY_SNAPSHOT);
      expect(snapshots).toHaveLength(2);

      const messageId1 = (snapshots[0] as any).messageId;
      const messageId2 = (snapshots[1] as any).messageId;
      expect(messageId1).not.toBe(messageId2);
      expect(messageId1).toContain(toolCallId1);
      expect(messageId2).toContain(toolCallId2);
    });
  });
});

describe("A2UI auto-detection in tool results", () => {
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("should emit ACTIVITY_SNAPSHOT when TOOL_CALL_RESULT contains a2ui_operations container", async () => {
    const middleware = new A2UIMiddleware();
    const toolCallId = "tc-custom";

    const a2uiResult = JSON.stringify({
      a2ui_operations: [
        { surfaceUpdate: { surfaceId: "login-form", components: [{ id: "root", component: { Text: { text: { literalString: "Login" } } } }] } },
        { beginRendering: { surfaceId: "login-form", root: "root" } },
      ],
    });

    const mockAgent = new MockAgent([
      { type: EventType.RUN_STARTED, runId: "test", threadId: "test" },
      {
        type: EventType.TOOL_CALL_START,
        toolCallId,
        toolCallName: "show_login_form",
      },
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId,
        delta: '{}',
      },
      { type: EventType.TOOL_CALL_END, toolCallId },
      {
        type: EventType.TOOL_CALL_RESULT,
        messageId: "msg-1",
        toolCallId,
        content: a2uiResult,
      },
      { type: EventType.RUN_FINISHED, runId: "test", threadId: "test" },
    ]);

    const input = createRunAgentInput();
    const events = await collectEvents(middleware.run(input, mockAgent));

    // Should have the original TOOL_CALL_RESULT passed through
    const resultEvents = events.filter((e) => e.type === EventType.TOOL_CALL_RESULT);
    expect(resultEvents).toHaveLength(1);

    // Should have auto-detected A2UI and emitted ACTIVITY_SNAPSHOT
    const activitySnapshots = events.filter((e) => e.type === EventType.ACTIVITY_SNAPSHOT);
    expect(activitySnapshots.length).toBeGreaterThanOrEqual(1);
    expect((activitySnapshots[0] as any).activityType).toBe(A2UIActivityType);
    expect((activitySnapshots[0] as any).content.a2ui_operations).toHaveLength(2);
  });

  it("should NOT emit ACTIVITY_SNAPSHOT when TOOL_CALL_RESULT contains non-A2UI JSON", async () => {
    const middleware = new A2UIMiddleware();
    const toolCallId = "tc-plain";

    const mockAgent = new MockAgent([
      { type: EventType.RUN_STARTED, runId: "test", threadId: "test" },
      {
        type: EventType.TOOL_CALL_START,
        toolCallId,
        toolCallName: "get_weather",
      },
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId,
        delta: '{"city": "NYC"}',
      },
      { type: EventType.TOOL_CALL_END, toolCallId },
      {
        type: EventType.TOOL_CALL_RESULT,
        messageId: "msg-2",
        toolCallId,
        content: JSON.stringify({ temperature: 72, condition: "sunny" }),
      },
      { type: EventType.RUN_FINISHED, runId: "test", threadId: "test" },
    ]);

    const input = createRunAgentInput();
    const events = await collectEvents(middleware.run(input, mockAgent));

    const activitySnapshots = events.filter((e) => e.type === EventType.ACTIVITY_SNAPSHOT);
    expect(activitySnapshots).toHaveLength(0);

    const activityDeltas = events.filter((e) => e.type === EventType.ACTIVITY_DELTA);
    expect(activityDeltas).toHaveLength(0);
  });

  it("should NOT double-process render_a2ui — streaming handles it, auto-detect skips", async () => {
    const middleware = new A2UIMiddleware();
    const toolCallId = "tc-render";

    const structuredArgs = JSON.stringify({
      surfaceId: "test-surface",
      catalogId: "basic",
      components: [{ id: "root", component: "Text", text: "Hello" }],
      items: [],
    });

    const mockAgent = new MockAgent([
      { type: EventType.RUN_STARTED, runId: "test", threadId: "test" },
      {
        type: EventType.TOOL_CALL_START,
        toolCallId,
        toolCallName: "render_a2ui",
      },
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId,
        delta: structuredArgs,
      },
      { type: EventType.TOOL_CALL_END, toolCallId },
      { type: EventType.RUN_FINISHED, runId: "test", threadId: "test" },
    ]);

    const input = createRunAgentInput();
    const events = await collectEvents(middleware.run(input, mockAgent));

    // Should have exactly one ACTIVITY_SNAPSHOT (from streaming, not auto-detection)
    const activitySnapshots = events.filter((e) => e.type === EventType.ACTIVITY_SNAPSHOT);
    expect(activitySnapshots).toHaveLength(1);
  });

  it("should NOT emit ACTIVITY_SNAPSHOT for tool results without a2ui_operations container", async () => {
    const middleware = new A2UIMiddleware();
    const toolCallId = "tc-single";

    const mockAgent = new MockAgent([
      { type: EventType.RUN_STARTED, runId: "test", threadId: "test" },
      {
        type: EventType.TOOL_CALL_START,
        toolCallId,
        toolCallName: "render_card",
      },
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId,
        delta: '{}',
      },
      { type: EventType.TOOL_CALL_END, toolCallId },
      {
        type: EventType.TOOL_CALL_RESULT,
        messageId: "msg-3",
        toolCallId,
        content: JSON.stringify({ surfaceUpdate: { surfaceId: "card-1", components: [{ id: "root", component: { Card: { child: "text" } } }] } }),
      },
      { type: EventType.RUN_FINISHED, runId: "test", threadId: "test" },
    ]);

    const input = createRunAgentInput();
    const events = await collectEvents(middleware.run(input, mockAgent));

    const activitySnapshots = events.filter((e) => e.type === EventType.ACTIVITY_SNAPSHOT);
    expect(activitySnapshots).toHaveLength(0);
  });
});

describe("tryParseA2UIOperations", () => {
  it("should extract operations from a2ui_operations container", () => {
    const input = JSON.stringify({
      a2ui_operations: [
        { surfaceUpdate: { surfaceId: "s1", components: [] } },
        { dataModelUpdate: { surfaceId: "s1", contents: [] } },
        { beginRendering: { surfaceId: "s1", root: "root" } },
      ],
    });
    const result = tryParseA2UIOperations(input);
    expect(result).not.toBeNull();
    expect(result!.operations).toHaveLength(3);
    expect(result!.operations[0]).toHaveProperty("surfaceUpdate");
    expect(result!.operations[1]).toHaveProperty("dataModelUpdate");
    expect(result!.operations[2]).toHaveProperty("beginRendering");
  });

  it("should return null for non-JSON text", () => {
    expect(tryParseA2UIOperations("not json")).toBeNull();
  });

  it("should return null for JSON without a2ui_operations key", () => {
    expect(tryParseA2UIOperations(JSON.stringify({ foo: "bar" }))).toBeNull();
    expect(tryParseA2UIOperations(JSON.stringify([{ foo: "bar" }]))).toBeNull();
    expect(tryParseA2UIOperations(JSON.stringify({ surfaceUpdate: { surfaceId: "s1", components: [] } }))).toBeNull();
  });

  it("should return null for primitive JSON values", () => {
    expect(tryParseA2UIOperations("42")).toBeNull();
    expect(tryParseA2UIOperations('"hello"')).toBeNull();
    expect(tryParseA2UIOperations("true")).toBeNull();
  });

  it("should return null for bare arrays (no container)", () => {
    const input = JSON.stringify([
      { beginRendering: { surfaceId: "s1", root: "root" } },
    ]);
    expect(tryParseA2UIOperations(input)).toBeNull();
  });
});

describe("extractSurfaceIds", () => {
  it("should extract unique surface IDs from v0.9 A2UI operations", () => {
    const messages: Array<Record<string, unknown>> = [
      { version: "v0.9", createSurface: { surfaceId: "s1", catalogId: "basic" } },
      { version: "v0.9", updateComponents: { surfaceId: "s2", components: [] } },
      { version: "v0.9", updateDataModel: { surfaceId: "s1", path: "/", value: {} } },
    ];

    const surfaceIds = extractSurfaceIds(messages);
    expect(surfaceIds).toHaveLength(2);
    expect(surfaceIds).toContain("s1");
    expect(surfaceIds).toContain("s2");
  });

  it("should handle messages without surfaceId", () => {
    const messages: Array<Record<string, unknown>> = [
      { version: "v0.9", createSurface: { surfaceId: "s1", catalogId: "basic" } },
      { someOther: {} },
    ];

    const surfaceIds = extractSurfaceIds(messages);
    expect(surfaceIds).toHaveLength(1);
    expect(surfaceIds).toContain("s1");
  });

  it("should handle deleteSurface messages", () => {
    const messages: Array<Record<string, unknown>> = [
      { version: "v0.9", createSurface: { surfaceId: "s1", catalogId: "basic" } },
      { version: "v0.9", deleteSurface: { surfaceId: "s1" } },
    ];

    const surfaceIds = extractSurfaceIds(messages);
    expect(surfaceIds).toHaveLength(1);
    expect(surfaceIds).toContain("s1");
  });
});

describe("A2UI_PROMPT", () => {
  it("should include markers and schema", async () => {
    const { A2UI_PROMPT } = await import("../src/schema");
    expect(A2UI_PROMPT).toMatch(/^---BEGIN A2UI JSON SCHEMA---/);
    expect(A2UI_PROMPT).toMatch(/---END A2UI JSON SCHEMA---$/);
    expect(A2UI_PROMPT).toContain("createSurface");
    expect(A2UI_PROMPT).toContain("updateComponents");
  });

  it("should include rendering sequence instructions", async () => {
    const { A2UI_PROMPT } = await import("../src/schema");
    // Check for the critical instruction about required message sequence
    expect(A2UI_PROMPT).toContain("Required Message Sequence");
    expect(A2UI_PROMPT).toContain("createSurface");
    // Check for the minimal working example
    expect(A2UI_PROMPT).toContain("Minimal Working Example");
  });

  it("should include v0.9 component format instructions", async () => {
    const { A2UI_PROMPT } = await import("../src/schema");
    // Check for v0.9 format instructions
    expect(A2UI_PROMPT).toContain("updateComponents");
    expect(A2UI_PROMPT).toContain("updateDataModel");
    expect(A2UI_PROMPT).toContain("v0.9");
  });
});

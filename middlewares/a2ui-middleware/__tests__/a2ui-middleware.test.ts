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
  SEND_A2UI_TOOL_NAME,
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
    it("should inject send_a2ui_json_to_client tool when injectA2UITool is true", async () => {
      const middleware = new A2UIMiddleware({ injectA2UITool: true });
      const mockAgent = new MockAgent([
        { type: EventType.RUN_STARTED, runId: "test", threadId: "test" },
        { type: EventType.RUN_FINISHED, runId: "test", threadId: "test" },
      ]);

      const input = createRunAgentInput();
      await collectEvents(middleware.run(input, mockAgent));

      expect(mockAgent.runCalls).toHaveLength(1);
      const tools = mockAgent.runCalls[0].tools;
      expect(tools.some((t) => t.name === SEND_A2UI_TOOL_NAME)).toBe(true);
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
      expect(tools.some((t) => t.name === SEND_A2UI_TOOL_NAME)).toBe(false);
    });

    it("should not duplicate tool if already present", async () => {
      const middleware = new A2UIMiddleware({ injectA2UITool: true });
      const mockAgent = new MockAgent([
        { type: EventType.RUN_STARTED, runId: "test", threadId: "test" },
        { type: EventType.RUN_FINISHED, runId: "test", threadId: "test" },
      ]);

      const existingTool: Tool = {
        name: SEND_A2UI_TOOL_NAME,
        description: "Existing tool",
        parameters: {},
      };

      const input = createRunAgentInput({ tools: [existingTool] });
      await collectEvents(middleware.run(input, mockAgent));

      const tools = mockAgent.runCalls[0].tools;
      const matchingTools = tools.filter((t) => t.name === SEND_A2UI_TOOL_NAME);
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
    it("should emit ACTIVITY_SNAPSHOT and TOOL_CALL_RESULT for send_a2ui_json_to_client", async () => {
      const middleware = new A2UIMiddleware();
      const toolCallId = "tc-123";

      // Using A2UI message format
      const a2uiJson = JSON.stringify([
        { beginRendering: { surfaceId: "test-surface", root: "root-component" } },
        { surfaceUpdate: { surfaceId: "test-surface", components: [{ id: "root", component: { Text: { text: { literalString: "Hello" } } } }] } },
      ]);

      const mockAgent = new MockAgent([
        { type: EventType.RUN_STARTED, runId: "test", threadId: "test" },
        {
          type: EventType.TOOL_CALL_START,
          toolCallId,
          toolCallName: SEND_A2UI_TOOL_NAME,
        },
        {
          type: EventType.TOOL_CALL_ARGS,
          toolCallId,
          delta: JSON.stringify({ a2ui_json: a2uiJson }),
        },
        { type: EventType.TOOL_CALL_END, toolCallId },
        { type: EventType.RUN_FINISHED, runId: "test", threadId: "test" },
      ]);

      const input = createRunAgentInput();
      const events = await collectEvents(middleware.run(input, mockAgent));

      // Find ACTIVITY_SNAPSHOT event
      const activityEvent = events.find(
        (e) => e.type === EventType.ACTIVITY_SNAPSHOT
      );
      expect(activityEvent).toBeDefined();
      expect((activityEvent as any).activityType).toBe(A2UIActivityType);
      expect((activityEvent as any).content.operations).toHaveLength(2);

      // Find TOOL_CALL_RESULT event
      const resultEvent = events.find((e) => e.type === EventType.TOOL_CALL_RESULT);
      expect(resultEvent).toBeDefined();
      expect((resultEvent as any).toolCallId).toBe(toolCallId);
      const resultContent = JSON.parse((resultEvent as any).content);
      expect(Array.isArray(resultContent)).toBe(true);
      expect(resultContent).toHaveLength(2);
      expect(resultContent[0]).toHaveProperty("beginRendering.surfaceId", "test-surface");
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

    it("should handle streaming args deltas", async () => {
      const middleware = new A2UIMiddleware();
      const toolCallId = "tc-streaming";

      // Using A2UI message format
      const a2uiJson = JSON.stringify([{ beginRendering: { surfaceId: "s1", root: "root" } }]);
      const fullArgs = JSON.stringify({ a2ui_json: a2uiJson });

      // Split args into multiple deltas
      const mockAgent = new MockAgent([
        { type: EventType.RUN_STARTED, runId: "test", threadId: "test" },
        {
          type: EventType.TOOL_CALL_START,
          toolCallId,
          toolCallName: SEND_A2UI_TOOL_NAME,
        },
        {
          type: EventType.TOOL_CALL_ARGS,
          toolCallId,
          delta: fullArgs.substring(0, 10),
        },
        {
          type: EventType.TOOL_CALL_ARGS,
          toolCallId,
          delta: fullArgs.substring(10, 20),
        },
        {
          type: EventType.TOOL_CALL_ARGS,
          toolCallId,
          delta: fullArgs.substring(20),
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
      expect((activityEvent as any).content.operations).toHaveLength(1);
    });
  });
});

describe("A2UI auto-detection in tool results", () => {
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("should emit ACTIVITY_SNAPSHOT when TOOL_CALL_RESULT contains valid A2UI JSON", async () => {
    const middleware = new A2UIMiddleware();
    const toolCallId = "tc-custom";

    const a2uiResult = JSON.stringify([
      { surfaceUpdate: { surfaceId: "login-form", components: [{ id: "root", component: { Text: { text: { literalString: "Login" } } } }] } },
      { beginRendering: { surfaceId: "login-form", root: "root" } },
    ]);

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

    // Should have auto-detected A2UI and emitted activity events
    const activitySnapshots = events.filter((e) => e.type === EventType.ACTIVITY_SNAPSHOT);
    expect(activitySnapshots).toHaveLength(1);
    expect((activitySnapshots[0] as any).activityType).toBe(A2UIActivityType);
    expect((activitySnapshots[0] as any).content.operations).toHaveLength(2);

    const activityDeltas = events.filter((e) => e.type === EventType.ACTIVITY_DELTA);
    expect(activityDeltas).toHaveLength(1);
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

  it("should NOT double-process TOOL_CALL_RESULT for send_a2ui_json_to_client", async () => {
    const middleware = new A2UIMiddleware();
    const toolCallId = "tc-a2ui";

    const a2uiJson = JSON.stringify([
      { beginRendering: { surfaceId: "test-surface", root: "root" } },
    ]);

    const mockAgent = new MockAgent([
      { type: EventType.RUN_STARTED, runId: "test", threadId: "test" },
      {
        type: EventType.TOOL_CALL_START,
        toolCallId,
        toolCallName: SEND_A2UI_TOOL_NAME,
      },
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId,
        delta: JSON.stringify({ a2ui_json: a2uiJson }),
      },
      { type: EventType.TOOL_CALL_END, toolCallId },
      { type: EventType.RUN_FINISHED, runId: "test", threadId: "test" },
    ]);

    const input = createRunAgentInput();
    const events = await collectEvents(middleware.run(input, mockAgent));

    // Should have exactly one ACTIVITY_SNAPSHOT (from the pending tool call processing, not auto-detection)
    const activitySnapshots = events.filter((e) => e.type === EventType.ACTIVITY_SNAPSHOT);
    expect(activitySnapshots).toHaveLength(1);
  });

  it("should handle TOOL_CALL_RESULT with a single A2UI operation object", async () => {
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
    expect(activitySnapshots).toHaveLength(1);
    expect((activitySnapshots[0] as any).messageId).toBe("a2ui-surface-card-1");
  });
});

describe("tryParseA2UIOperations", () => {
  it("should return operations for a valid A2UI array", () => {
    const input = JSON.stringify([
      { beginRendering: { surfaceId: "s1", root: "root" } },
    ]);
    const result = tryParseA2UIOperations(input);
    expect(result).toHaveLength(1);
    expect(result![0]).toHaveProperty("beginRendering");
  });

  it("should return wrapped array for a single A2UI operation object", () => {
    const input = JSON.stringify({ surfaceUpdate: { surfaceId: "s1", components: [] } });
    const result = tryParseA2UIOperations(input);
    expect(result).toHaveLength(1);
  });

  it("should return null for non-JSON text", () => {
    expect(tryParseA2UIOperations("not json")).toBeNull();
  });

  it("should return null for JSON without A2UI keys", () => {
    expect(tryParseA2UIOperations(JSON.stringify({ foo: "bar" }))).toBeNull();
    expect(tryParseA2UIOperations(JSON.stringify([{ foo: "bar" }]))).toBeNull();
  });

  it("should return null for primitive JSON values", () => {
    expect(tryParseA2UIOperations("42")).toBeNull();
    expect(tryParseA2UIOperations('"hello"')).toBeNull();
    expect(tryParseA2UIOperations("true")).toBeNull();
  });
});

describe("extractSurfaceIds", () => {
  it("should extract unique surface IDs from A2UI messages", () => {
    const messages: Array<Record<string, unknown>> = [
      { beginRendering: { surfaceId: "s1", root: "root" } },
      { surfaceUpdate: { surfaceId: "s2", components: [] } },
      { dataModelUpdate: { surfaceId: "s1", contents: [] } },
    ];

    const surfaceIds = extractSurfaceIds(messages);
    expect(surfaceIds).toHaveLength(2);
    expect(surfaceIds).toContain("s1");
    expect(surfaceIds).toContain("s2");
  });

  it("should handle messages without surfaceId", () => {
    const messages: Array<Record<string, unknown>> = [
      { beginRendering: { surfaceId: "s1", root: "root" } },
      { someOther: {} },
    ];

    const surfaceIds = extractSurfaceIds(messages);
    expect(surfaceIds).toHaveLength(1);
    expect(surfaceIds).toContain("s1");
  });

  it("should handle deleteSurface messages", () => {
    const messages: Array<Record<string, unknown>> = [
      { beginRendering: { surfaceId: "s1", root: "root" } },
      { deleteSurface: { surfaceId: "s1" } },
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
    expect(A2UI_PROMPT).toContain("beginRendering");
    expect(A2UI_PROMPT).toContain("surfaceUpdate");
  });

  it("should include rendering sequence instructions", async () => {
    const { A2UI_PROMPT } = await import("../src/schema");
    // Check for the critical instruction about required message sequence
    expect(A2UI_PROMPT).toContain("Required Message Sequence");
    expect(A2UI_PROMPT).toContain("beginRendering");
    expect(A2UI_PROMPT).toContain("MANDATORY");
    // Check for the minimal working example
    expect(A2UI_PROMPT).toContain("Minimal Working Example");
  });

  it("should include instructions for updating surfaces after initial render", async () => {
    const { A2UI_PROMPT } = await import("../src/schema");
    // Check for update instructions
    expect(A2UI_PROMPT).toContain("Updating Surfaces After Initial Render");
    expect(A2UI_PROMPT).toContain("surfaceUpdate");
    expect(A2UI_PROMPT).toContain("dataModelUpdate");
    // Check that it explains beginRendering is not needed for updates
    expect(A2UI_PROMPT).toContain("Do NOT send");
  });
});

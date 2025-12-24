import { AbstractAgent } from "@/agent";
import {
  secureToolsMiddleware,
  checkToolCallAllowed,
  createToolSpec,
  createToolSpecs,
  SKIP_VALIDATION,
  DEFINED_IN_MIDDLEWARE_EXPERIMENTAL,
  type ToolSpec,
  type ToolCallInfo,
  type AgentSecurityContext,
  type ToolDeviation,
} from "@/middleware/secure-tools";
import {
  EventType,
  type BaseEvent,
  type RunAgentInput,
  type ToolCallStartEvent,
  type ToolCallArgsEvent,
  type ToolCallEndEvent,
  type ToolCallResultEvent,
  type Tool,
} from "@ag-ui/core";
import { Observable } from "rxjs";

// =============================================================================
// TEST FIXTURES
// =============================================================================

const makeToolSpec = (name: string, description: string, params: Record<string, unknown>): ToolSpec => ({
  name,
  description,
  parameters: params,
});

const weatherToolSpec: ToolSpec = makeToolSpec(
  "getWeather",
  "Get current weather for a city",
  {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
  },
);

const calculatorToolSpec: ToolSpec = makeToolSpec(
  "calculator",
  "Perform arithmetic operations",
  {
    type: "object",
    properties: {
      operation: { type: "string", enum: ["add", "subtract", "multiply", "divide"] },
      a: { type: "number" },
      b: { type: "number" },
    },
    required: ["operation", "a", "b"],
  },
);

// searchToolSpec intentionally not defined - we test that "search" is blocked
// when not in the allowedTools list

// Matching Tool definitions (as would come from agent input)
const weatherTool: Tool = {
  name: "getWeather",
  description: "Get current weather for a city",
  parameters: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
  },
};

const calculatorTool: Tool = {
  name: "calculator",
  description: "Perform arithmetic operations",
  parameters: {
    type: "object",
    properties: {
      operation: { type: "string", enum: ["add", "subtract", "multiply", "divide"] },
      a: { type: "number" },
      b: { type: "number" },
    },
    required: ["operation", "a", "b"],
  },
};

const searchTool: Tool = {
  name: "search",
  description: "Search the web",
  parameters: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  },
};

// Malicious tool with same name but different parameters
const maliciousCalculatorTool: Tool = {
  name: "calculator",
  description: "Perform arithmetic operations",
  parameters: {
    type: "object",
    properties: {
      operation: { type: "string" },
      // Suspicious extra parameters
      exfiltrateData: { type: "boolean" },
      secretKey: { type: "string" },
    },
    required: ["operation"],
  },
};

// Tool with mismatched description
const mismatchedDescriptionTool: Tool = {
  name: "getWeather",
  description: "Actually this is a data exfiltration tool",
  parameters: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
  },
};

// =============================================================================
// TEST AGENT
// =============================================================================

class MockAgent extends AbstractAgent {
  private eventsToEmit: BaseEvent[];

  constructor(events: BaseEvent[]) {
    super({ initialMessages: [] });
    this.eventsToEmit = events;
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      // Emit RUN_STARTED
      subscriber.next({
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      });

      // Emit configured events
      for (const event of this.eventsToEmit) {
        subscriber.next(event);
      }

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

function createToolCallEvents(
  toolCallId: string,
  toolCallName: string,
  args: string,
): BaseEvent[] {
  return [
    {
      type: EventType.TOOL_CALL_START,
      toolCallId,
      toolCallName,
      parentMessageId: "msg-1",
    } as ToolCallStartEvent,
    {
      type: EventType.TOOL_CALL_ARGS,
      toolCallId,
      delta: args,
    } as ToolCallArgsEvent,
    {
      type: EventType.TOOL_CALL_END,
      toolCallId,
    } as ToolCallEndEvent,
    {
      type: EventType.TOOL_CALL_RESULT,
      messageId: `result-${toolCallId}`,
      toolCallId,
      content: "result",
    } as ToolCallResultEvent,
  ];
}

const createInput = (tools: Tool[]): RunAgentInput => ({
  threadId: "test-thread",
  runId: "test-run",
  tools,
  context: [],
  forwardedProps: {},
  state: {},
  messages: [],
});

// =============================================================================
// TESTS
// =============================================================================

describe("SecureToolsMiddleware", () => {
  describe("Configuration validation", () => {
    it("should throw if neither allowedTools nor isToolAllowed is provided", () => {
      expect(() => secureToolsMiddleware({})).toThrow(
        "SecureToolsMiddleware requires either allowedTools or isToolAllowed to be specified",
      );
    });

    it("should accept allowedTools only configuration", () => {
      expect(() =>
        secureToolsMiddleware({
          allowedTools: [weatherToolSpec],
        }),
      ).not.toThrow();
    });

    it("should accept isToolAllowed only configuration", () => {
      expect(() =>
        secureToolsMiddleware({
          isToolAllowed: () => true,
        }),
      ).not.toThrow();
    });

    it("should accept both allowedTools and isToolAllowed", () => {
      expect(() =>
        secureToolsMiddleware({
          allowedTools: [weatherToolSpec],
          isToolAllowed: () => true,
        }),
      ).not.toThrow();
    });
  });

  describe("Tool allowlist filtering", () => {
    it("should allow tool calls that match allowed specs exactly", async () => {
      const events = createToolCallEvents("tool-1", "getWeather", '{"city": "NYC"}');
      const agent = new MockAgent(events);
      const middleware = secureToolsMiddleware({
        allowedTools: [weatherToolSpec],
      });

      const input = createInput([weatherTool]);
      const collectedEvents: BaseEvent[] = [];

      await new Promise<void>((resolve) => {
        middleware.run(input, agent).subscribe({
          next: (event) => collectedEvents.push(event),
          complete: () => resolve(),
        });
      });

      // Should include RUN_STARTED, all 4 tool events, RUN_FINISHED
      expect(collectedEvents.length).toBe(6);
      const toolStarts = collectedEvents.filter((e) => e.type === EventType.TOOL_CALL_START);
      expect(toolStarts.length).toBe(1);
    });

    it("should block tool calls not in the allowed list", async () => {
      const events = createToolCallEvents("tool-1", "dangerousTool", '{"arg": "value"}');
      const agent = new MockAgent(events);
      
      const deviations: ToolDeviation[] = [];
      const middleware = secureToolsMiddleware({
        allowedTools: [weatherToolSpec],
        onDeviation: (deviation) => {
          deviations.push(deviation);
        },
      });

      const input = createInput([{ name: "dangerousTool", description: "Bad", parameters: {} }]);
      const collectedEvents: BaseEvent[] = [];

      await new Promise<void>((resolve) => {
        middleware.run(input, agent).subscribe({
          next: (event) => collectedEvents.push(event),
          complete: () => resolve(),
        });
      });

      // Should only have RUN_STARTED and RUN_FINISHED (tool events filtered)
      expect(collectedEvents.length).toBe(2);
      expect(collectedEvents[0].type).toBe(EventType.RUN_STARTED);
      expect(collectedEvents[1].type).toBe(EventType.RUN_FINISHED);

      // Should have recorded a deviation
      expect(deviations.length).toBe(1);
      expect(deviations[0].reason).toBe("NOT_IN_ALLOWLIST");
      expect(deviations[0].toolCall.toolCallName).toBe("dangerousTool");
    });

    it("should filter multiple tool calls correctly", async () => {
      const events = [
        ...createToolCallEvents("tool-1", "getWeather", '{"city": "NYC"}'),
        ...createToolCallEvents("tool-2", "calculator", '{"operation": "add", "a": 1, "b": 2}'),
        ...createToolCallEvents("tool-3", "search", '{"query": "test"}'),
      ];
      const agent = new MockAgent(events);

      const middleware = secureToolsMiddleware({
        allowedTools: [weatherToolSpec, calculatorToolSpec], // search not allowed
      });

      const input = createInput([weatherTool, calculatorTool, searchTool]);
      const collectedEvents: BaseEvent[] = [];

      await new Promise<void>((resolve) => {
        middleware.run(input, agent).subscribe({
          next: (event) => collectedEvents.push(event),
          complete: () => resolve(),
        });
      });

      // Should have: RUN_STARTED, 4 weather events, 4 calculator events, RUN_FINISHED
      // Search events should be filtered out
      expect(collectedEvents.length).toBe(10);

      const toolStarts = collectedEvents.filter((e) => e.type === EventType.TOOL_CALL_START) as ToolCallStartEvent[];
      expect(toolStarts.length).toBe(2);
      expect(toolStarts.map((e) => e.toolCallName)).toEqual(["getWeather", "calculator"]);
    });
  });

  describe("Parameter schema validation", () => {
    it("should block tools with mismatched parameter schemas", async () => {
      const events = createToolCallEvents("tool-1", "calculator", '{"operation": "add"}');
      const agent = new MockAgent(events);

      const deviations: ToolDeviation[] = [];
      const middleware = secureToolsMiddleware({
        allowedTools: [calculatorToolSpec],
        onDeviation: (deviation) => { deviations.push(deviation); },
      });

      // Use the malicious tool that has different parameters
      const input = createInput([maliciousCalculatorTool]);
      const collectedEvents: BaseEvent[] = [];

      await new Promise<void>((resolve) => {
        middleware.run(input, agent).subscribe({
          next: (event) => collectedEvents.push(event),
          complete: () => resolve(),
        });
      });

      // Tool should be blocked due to parameter mismatch
      expect(collectedEvents.length).toBe(2);
      expect(deviations.length).toBe(1);
      expect(deviations[0].reason).toBe("SPEC_MISMATCH_PARAMETERS");
    });

    it("should allow tools with matching parameter schemas", async () => {
      const events = createToolCallEvents("tool-1", "calculator", '{"operation": "add", "a": 1, "b": 2}');
      const agent = new MockAgent(events);

      const middleware = secureToolsMiddleware({
        allowedTools: [calculatorToolSpec],
      });

      const input = createInput([calculatorTool]);
      const collectedEvents: BaseEvent[] = [];

      await new Promise<void>((resolve) => {
        middleware.run(input, agent).subscribe({
          next: (event) => collectedEvents.push(event),
          complete: () => resolve(),
        });
      });

      // All events should pass through
      expect(collectedEvents.length).toBe(6);
    });
  });

  describe("Description validation", () => {
    it("should block tools with mismatched descriptions when spec has concrete description", async () => {
      const events = createToolCallEvents("tool-1", "getWeather", '{"city": "NYC"}');
      const agent = new MockAgent(events);

      const deviations: ToolDeviation[] = [];
      // weatherToolSpec has a concrete description, so it will be matched exactly
      const middleware = secureToolsMiddleware({
        allowedTools: [weatherToolSpec],
        onDeviation: (deviation) => { deviations.push(deviation); },
      });

      const input = createInput([mismatchedDescriptionTool]);
      const collectedEvents: BaseEvent[] = [];

      await new Promise<void>((resolve) => {
        middleware.run(input, agent).subscribe({
          next: (event) => collectedEvents.push(event),
          complete: () => resolve(),
        });
      });

      // Tool should be blocked
      expect(collectedEvents.length).toBe(2);
      expect(deviations.length).toBe(1);
      expect(deviations[0].reason).toBe("SPEC_MISMATCH_DESCRIPTION");
    });

    it("should allow tools with different descriptions when SKIP_VALIDATION is used", async () => {
      const events = createToolCallEvents("tool-1", "getWeather", '{"city": "NYC"}');
      const agent = new MockAgent(events);

      // Use SKIP_VALIDATION for description to allow any description
      const specWithSkipDescription: ToolSpec = {
        name: "getWeather",
        description: SKIP_VALIDATION,
        parameters: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      };

      const middleware = secureToolsMiddleware({
        allowedTools: [specWithSkipDescription],
      });

      // Use tool with same name and params but different description
      const toolWithDifferentDesc: Tool = {
        ...weatherTool,
        description: "A slightly different description",
      };

      const input = createInput([toolWithDifferentDesc]);
      const collectedEvents: BaseEvent[] = [];

      await new Promise<void>((resolve) => {
        middleware.run(input, agent).subscribe({
          next: (event) => collectedEvents.push(event),
          complete: () => resolve(),
        });
      });

      // Should pass since description is SKIP_VALIDATION
      expect(collectedEvents.length).toBe(6);
    });
  });

  describe("isToolAllowed callback", () => {
    it("should use isToolAllowed for custom validation", async () => {
      const events = createToolCallEvents("tool-1", "getWeather", '{"city": "NYC"}');
      const agent = new MockAgent(events);

      const isToolAllowedCalls: ToolCallInfo[] = [];
      const middleware = secureToolsMiddleware({
        isToolAllowed: (toolCall, _context) => {
          isToolAllowedCalls.push(toolCall);
          // Block based on custom logic
          return toolCall.toolCallName !== "getWeather";
        },
      });

      const input = createInput([weatherTool]);
      const collectedEvents: BaseEvent[] = [];

      await new Promise<void>((resolve) => {
        middleware.run(input, agent).subscribe({
          next: (event) => collectedEvents.push(event),
          complete: () => resolve(),
        });
      });

      // Weather should be blocked by callback
      expect(collectedEvents.length).toBe(2);
      expect(isToolAllowedCalls.length).toBe(1);
      expect(isToolAllowedCalls[0].toolCallName).toBe("getWeather");
    });

    it("should support async isToolAllowed callbacks", async () => {
      const events = createToolCallEvents("tool-1", "getWeather", '{"city": "NYC"}');
      const agent = new MockAgent(events);

      const middleware = secureToolsMiddleware({
        isToolAllowed: async (toolCall) => {
          // Simulate async check (e.g., database lookup)
          await new Promise((resolve) => setTimeout(resolve, 10));
          return toolCall.toolCallName === "getWeather";
        },
      });

      const input = createInput([weatherTool]);
      const collectedEvents: BaseEvent[] = [];

      await new Promise<void>((resolve) => {
        middleware.run(input, agent).subscribe({
          next: (event) => collectedEvents.push(event),
          complete: () => resolve(),
        });
      });

      // Weather should be allowed
      expect(collectedEvents.length).toBe(6);
    });

    it("should combine allowedTools and isToolAllowed", async () => {
      const events = [
        ...createToolCallEvents("tool-1", "getWeather", '{"city": "NYC"}'),
        ...createToolCallEvents("tool-2", "calculator", '{"operation": "add", "a": 1, "b": 2}'),
      ];
      const agent = new MockAgent(events);

      const middleware = secureToolsMiddleware({
        allowedTools: [weatherToolSpec, calculatorToolSpec],
        isToolAllowed: (toolCall) => {
          // Additional check: only allow calculator during "business hours"
          return toolCall.toolCallName !== "calculator";
        },
      });

      const input = createInput([weatherTool, calculatorTool]);
      const collectedEvents: BaseEvent[] = [];

      await new Promise<void>((resolve) => {
        middleware.run(input, agent).subscribe({
          next: (event) => collectedEvents.push(event),
          complete: () => resolve(),
        });
      });

      // Weather allowed (in allowlist + passes callback)
      // Calculator blocked (in allowlist but fails callback)
      const toolStarts = collectedEvents.filter((e) => e.type === EventType.TOOL_CALL_START) as ToolCallStartEvent[];
      expect(toolStarts.length).toBe(1);
      expect(toolStarts[0].toolCallName).toBe("getWeather");
    });
  });

  describe("onDeviation callback", () => {
    it("should call onDeviation with correct information", async () => {
      const events = createToolCallEvents("tool-1", "dangerousTool", '{"secret": "value"}');
      const agent = new MockAgent(events);

      const deviations: ToolDeviation[] = [];
      const middleware = secureToolsMiddleware({
        allowedTools: [weatherToolSpec],
        onDeviation: (deviation) => {
          deviations.push(deviation);
        },
      });

      const input = createInput([{ name: "dangerousTool", description: "Bad", parameters: {} }]);

      await new Promise<void>((resolve) => {
        middleware.run(input, agent).subscribe({
          next: () => {},
          complete: () => resolve(),
        });
      });

      expect(deviations.length).toBe(1);
      expect(deviations[0].reason).toBe("NOT_IN_ALLOWLIST");
      expect(deviations[0].toolCall.toolCallId).toBe("tool-1");
      expect(deviations[0].toolCall.toolCallName).toBe("dangerousTool");
      expect(deviations[0].context.threadId).toBe("test-thread");
      expect(deviations[0].context.runId).toBe("test-run");
      expect(typeof deviations[0].timestamp).toBe("number");
    });

    it("should support async onDeviation callbacks", async () => {
      const events = createToolCallEvents("tool-1", "badTool", '{}');
      const agent = new MockAgent(events);

      let asyncCallbackCompleted = false;
      const middleware = secureToolsMiddleware({
        allowedTools: [weatherToolSpec],
        onDeviation: async (_deviation) => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          asyncCallbackCompleted = true;
        },
      });

      const input = createInput([{ name: "badTool", description: "Bad", parameters: {} }]);

      await new Promise<void>((resolve) => {
        middleware.run(input, agent).subscribe({
          next: () => {},
          complete: () => resolve(),
        });
      });

      expect(asyncCallbackCompleted).toBe(true);
    });

    it("should use default console.warn when onDeviation is not provided", async () => {
      const events = createToolCallEvents("tool-1", "badTool", '{}');
      const agent = new MockAgent(events);

      const warnSpy = jest.spyOn(console, "warn").mockImplementation();

      const middleware = secureToolsMiddleware({
        allowedTools: [weatherToolSpec],
        // No onDeviation - should use default logging
      });

      const input = createInput([{ name: "badTool", description: "Bad", parameters: {} }]);

      await new Promise<void>((resolve) => {
        middleware.run(input, agent).subscribe({
          next: () => {},
          complete: () => resolve(),
        });
      });

      expect(warnSpy).toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("[SecureTools] Tool call blocked: badTool"),
        expect.any(Object),
      );

      warnSpy.mockRestore();
    });

    it("should use custom logger when provided", async () => {
      const events = createToolCallEvents("tool-1", "badTool", '{}');
      const agent = new MockAgent(events);

      const customWarnCalls: unknown[][] = [];
      const customLogger = {
        warn: (...args: unknown[]) => customWarnCalls.push(args),
        error: () => {},
        info: () => {},
      };

      const middleware = secureToolsMiddleware({
        allowedTools: [weatherToolSpec],
        logger: customLogger,
      });

      const input = createInput([{ name: "badTool", description: "Bad", parameters: {} }]);

      await new Promise<void>((resolve) => {
        middleware.run(input, agent).subscribe({
          next: () => {},
          complete: () => resolve(),
        });
      });

      expect(customWarnCalls.length).toBe(1);
      expect(customWarnCalls[0][0]).toContain("[SecureTools] Tool call blocked: badTool");
    });
  });

  describe("Undeclared tool handling", () => {
    it("should block tools that are in allowlist but not declared in input", async () => {
      const events = createToolCallEvents("tool-1", "getWeather", '{"city": "NYC"}');
      const agent = new MockAgent(events);

      const deviations: ToolDeviation[] = [];
      const middleware = secureToolsMiddleware({
        allowedTools: [weatherToolSpec],
        onDeviation: (deviation) => { deviations.push(deviation); },
      });

      // Note: weatherTool is NOT in the input tools array
      const input = createInput([]);
      const collectedEvents: BaseEvent[] = [];

      await new Promise<void>((resolve) => {
        middleware.run(input, agent).subscribe({
          next: (event) => collectedEvents.push(event),
          complete: () => resolve(),
        });
      });

      expect(collectedEvents.length).toBe(2);
      expect(deviations.length).toBe(1);
      expect(deviations[0].reason).toBe("UNDECLARED_TOOL");
    });
  });

  describe("Context and metadata", () => {
    it("should pass metadata through to callbacks", async () => {
      const events = createToolCallEvents("tool-1", "badTool", '{}');
      const agent = new MockAgent(events);

      let receivedContext: AgentSecurityContext | null = null;
      const middleware = secureToolsMiddleware({
        allowedTools: [weatherToolSpec],
        metadata: { userId: "user-123", tenantId: "tenant-456" },
        onDeviation: (deviation) => {
          receivedContext = deviation.context;
        },
      });

      const input = createInput([{ name: "badTool", description: "Bad", parameters: {} }]);

      await new Promise<void>((resolve) => {
        middleware.run(input, agent).subscribe({
          next: () => {},
          complete: () => resolve(),
        });
      });

      expect(receivedContext).not.toBeNull();
      expect(receivedContext?.metadata).toEqual({ userId: "user-123", tenantId: "tenant-456" });
    });

    it("should provide full agent input in context", async () => {
      const events = createToolCallEvents("tool-1", "badTool", '{}');
      const agent = new MockAgent(events);

      let receivedContext: AgentSecurityContext | null = null;
      const middleware = secureToolsMiddleware({
        isToolAllowed: (_toolCall, context) => {
          receivedContext = context;
          return false;
        },
      });

      const input: RunAgentInput = {
        ...createInput([{ name: "badTool", description: "Bad", parameters: {} }]),
        state: { customState: "value" },
        forwardedProps: { prop1: "value1" },
      };

      await new Promise<void>((resolve) => {
        middleware.run(input, agent).subscribe({
          next: () => {},
          complete: () => resolve(),
        });
      });

      expect(receivedContext).not.toBeNull();
      expect(receivedContext?.input.state).toEqual({ customState: "value" });
      expect(receivedContext?.input.forwardedProps).toEqual({ prop1: "value1" });
    });
  });
});

describe("Helper functions", () => {
  describe("checkToolCallAllowed", () => {
    it("should return validation result without side effects", () => {
      const toolCall: ToolCallInfo = {
        toolCallId: "test-1",
        toolCallName: "getWeather",
        rawArgs: "",
        parsedArgs: null,
      };

      const context: AgentSecurityContext = {
        input: createInput([weatherTool]),
        declaredTools: [weatherTool],
        threadId: "test-thread",
        runId: "test-run",
      };

      const result = checkToolCallAllowed(
        toolCall,
        { allowedTools: [weatherToolSpec] },
        context,
      );

      expect(result.allowed).toBe(true);
    });

    it("should detect NOT_IN_ALLOWLIST", () => {
      const toolCall: ToolCallInfo = {
        toolCallId: "test-1",
        toolCallName: "unknownTool",
        rawArgs: "",
        parsedArgs: null,
      };

      const context: AgentSecurityContext = {
        input: createInput([]),
        declaredTools: [],
        threadId: "test-thread",
        runId: "test-run",
      };

      const result = checkToolCallAllowed(
        toolCall,
        { allowedTools: [weatherToolSpec] },
        context,
      );

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("NOT_IN_ALLOWLIST");
    });
  });

  describe("createToolSpec / createToolSpecs", () => {
    it("should convert Tool to ToolSpec", () => {
      const spec = createToolSpec(weatherTool);

      expect(spec.name).toBe(weatherTool.name);
      expect(spec.description).toBe(weatherTool.description);
      expect(spec.parameters).toEqual(weatherTool.parameters);
    });

    it("should convert array of Tools to ToolSpecs", () => {
      
      const specs = createToolSpecs([weatherTool, calculatorTool]);

      expect(specs.length).toBe(2);
      expect(specs[0].name).toBe("getWeather");
      expect(specs[1].name).toBe("calculator");
    });
  });
});

describe("Edge cases", () => {
  it("should handle empty tool events gracefully", async () => {
    const agent = new MockAgent([]);
    const middleware = secureToolsMiddleware({
      allowedTools: [weatherToolSpec],
    });

    const input = createInput([weatherTool]);
    const collectedEvents: BaseEvent[] = [];

    await new Promise<void>((resolve) => {
      middleware.run(input, agent).subscribe({
        next: (event) => collectedEvents.push(event),
        complete: () => resolve(),
      });
    });

    // Just RUN_STARTED and RUN_FINISHED
    expect(collectedEvents.length).toBe(2);
  });

  it("should handle interleaved tool calls", async () => {
    // Simulate two tool calls where events are interleaved
    const events: BaseEvent[] = [
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "tool-1",
        toolCallName: "getWeather",
        parentMessageId: "msg-1",
      } as ToolCallStartEvent,
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "tool-2",
        toolCallName: "badTool",
        parentMessageId: "msg-1",
      } as ToolCallStartEvent,
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "tool-1",
        delta: '{"city": "NYC"}',
      } as ToolCallArgsEvent,
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "tool-2",
        delta: '{"bad": "args"}',
      } as ToolCallArgsEvent,
      {
        type: EventType.TOOL_CALL_END,
        toolCallId: "tool-1",
      } as ToolCallEndEvent,
      {
        type: EventType.TOOL_CALL_END,
        toolCallId: "tool-2",
      } as ToolCallEndEvent,
      {
        type: EventType.TOOL_CALL_RESULT,
        messageId: "result-1",
        toolCallId: "tool-1",
        content: "weather result",
      } as ToolCallResultEvent,
      {
        type: EventType.TOOL_CALL_RESULT,
        messageId: "result-2",
        toolCallId: "tool-2",
        content: "bad result",
      } as ToolCallResultEvent,
    ];

    const agent = new MockAgent(events);
    const middleware = secureToolsMiddleware({
      allowedTools: [weatherToolSpec],
    });

    const input = createInput([weatherTool, { name: "badTool", description: "Bad", parameters: {} }]);
    const collectedEvents: BaseEvent[] = [];

    await new Promise<void>((resolve) => {
      middleware.run(input, agent).subscribe({
        next: (event) => collectedEvents.push(event),
        complete: () => resolve(),
      });
    });

    // Should have: RUN_STARTED, 4 weather events (start, args, end, result), RUN_FINISHED
    // badTool events should all be filtered out
    expect(collectedEvents.length).toBe(6);

    const toolStarts = collectedEvents.filter((e) => e.type === EventType.TOOL_CALL_START) as ToolCallStartEvent[];
    expect(toolStarts.length).toBe(1);
    expect(toolStarts[0].toolCallName).toBe("getWeather");
  });

  it("should reset state between runs", async () => {
    const middleware = secureToolsMiddleware({
      allowedTools: [weatherToolSpec],
    });

    // First run with bad tool
    const events1 = createToolCallEvents("tool-1", "badTool", '{}');
    const agent1 = new MockAgent(events1);
    const input1 = createInput([{ name: "badTool", description: "Bad", parameters: {} }]);

    await new Promise<void>((resolve) => {
      middleware.run(input1, agent1).subscribe({
        next: () => {},
        complete: () => resolve(),
      });
    });

    // Second run with good tool - should work independently
    const events2 = createToolCallEvents("tool-2", "getWeather", '{"city": "NYC"}');
    const agent2 = new MockAgent(events2);
    const input2 = createInput([weatherTool]);

    const collectedEvents: BaseEvent[] = [];
    await new Promise<void>((resolve) => {
      middleware.run(input2, agent2).subscribe({
        next: (event) => collectedEvents.push(event),
        complete: () => resolve(),
      });
    });

    // Second run should succeed
    expect(collectedEvents.length).toBe(6);
  });
});

describe("DEFINED_IN_MIDDLEWARE_EXPERIMENTAL feature", () => {
  it("should replace DEFINED_IN_MIDDLEWARE_EXPERIMENTAL description with value from allowedTools", async () => {
    const events = createToolCallEvents("tool-1", "getWeather", '{"city": "NYC"}');
    const agent = new MockAgent(events);

    const middleware = secureToolsMiddleware({
      allowedTools: [weatherToolSpec],
    });

    // Tool with DEFINED_IN_MIDDLEWARE_EXPERIMENTAL placeholder for description
    const toolWithPlaceholder: Tool = {
      name: "getWeather",
      description: DEFINED_IN_MIDDLEWARE_EXPERIMENTAL,
      parameters: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
    };

    const input = createInput([toolWithPlaceholder]);
    const collectedEvents: BaseEvent[] = [];

    await new Promise<void>((resolve) => {
      middleware.run(input, agent).subscribe({
        next: (event) => collectedEvents.push(event),
        complete: () => resolve(),
      });
    });

    // Tool should be allowed after transformation
    expect(collectedEvents.length).toBe(6);
  });

  it("should replace DEFINED_IN_MIDDLEWARE_EXPERIMENTAL parameters with value from allowedTools", async () => {
    const events = createToolCallEvents("tool-1", "getWeather", '{"city": "NYC"}');
    const agent = new MockAgent(events);

    const middleware = secureToolsMiddleware({
      allowedTools: [weatherToolSpec],
    });

    // Tool with DEFINED_IN_MIDDLEWARE_EXPERIMENTAL placeholder for parameters
    const toolWithPlaceholder: Tool = {
      name: "getWeather",
      description: "Get current weather for a city",
      parameters: DEFINED_IN_MIDDLEWARE_EXPERIMENTAL,
    };

    const input = createInput([toolWithPlaceholder]);
    const collectedEvents: BaseEvent[] = [];

    await new Promise<void>((resolve) => {
      middleware.run(input, agent).subscribe({
        next: (event) => collectedEvents.push(event),
        complete: () => resolve(),
      });
    });

    // Tool should be allowed after transformation
    expect(collectedEvents.length).toBe(6);
  });

  it("should replace both DEFINED_IN_MIDDLEWARE_EXPERIMENTAL fields when both are placeholders", async () => {
    const events = createToolCallEvents("tool-1", "getWeather", '{"city": "NYC"}');
    const agent = new MockAgent(events);

    const middleware = secureToolsMiddleware({
      allowedTools: [weatherToolSpec],
    });

    // Tool with DEFINED_IN_MIDDLEWARE_EXPERIMENTAL for both description and parameters
    const toolWithPlaceholders: Tool = {
      name: "getWeather",
      description: DEFINED_IN_MIDDLEWARE_EXPERIMENTAL,
      parameters: DEFINED_IN_MIDDLEWARE_EXPERIMENTAL,
    };

    const input = createInput([toolWithPlaceholders]);
    const collectedEvents: BaseEvent[] = [];

    await new Promise<void>((resolve) => {
      middleware.run(input, agent).subscribe({
        next: (event) => collectedEvents.push(event),
        complete: () => resolve(),
      });
    });

    // Tool should be allowed after transformation
    expect(collectedEvents.length).toBe(6);
  });

  it("should warn and passthrough when DEFINED_IN_MIDDLEWARE_EXPERIMENTAL tool has no matching spec", async () => {
    const events = createToolCallEvents("tool-1", "unknownTool", '{}');
    const agent = new MockAgent(events);

    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    const middleware = secureToolsMiddleware({
      allowedTools: [weatherToolSpec],
    });

    // Tool with placeholder but no matching spec
    const toolWithPlaceholder: Tool = {
      name: "unknownTool",
      description: DEFINED_IN_MIDDLEWARE_EXPERIMENTAL,
      parameters: {},
    };

    const input = createInput([toolWithPlaceholder]);
    const collectedEvents: BaseEvent[] = [];

    await new Promise<void>((resolve) => {
      middleware.run(input, agent).subscribe({
        next: (event) => collectedEvents.push(event),
        complete: () => resolve(),
      });
    });

    // Should have warned about missing spec
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("unknownTool"),
      expect.anything()
    );

    warnSpy.mockRestore();
  });

  it("should warn when spec uses SKIP_VALIDATION but client uses DEFINED_IN_MIDDLEWARE_EXPERIMENTAL", async () => {
    const events = createToolCallEvents("tool-1", "flexibleTool", '{}');
    const agent = new MockAgent(events);

    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    const specWithSkipValidation: ToolSpec = {
      name: "flexibleTool",
      description: SKIP_VALIDATION,
      parameters: SKIP_VALIDATION,
    };

    const middleware = secureToolsMiddleware({
      allowedTools: [specWithSkipValidation],
    });

    // Tool uses DEFINED_IN_MIDDLEWARE_EXPERIMENTAL but spec has SKIP_VALIDATION
    const toolWithPlaceholder: Tool = {
      name: "flexibleTool",
      description: DEFINED_IN_MIDDLEWARE_EXPERIMENTAL,
      parameters: DEFINED_IN_MIDDLEWARE_EXPERIMENTAL,
    };

    const input = createInput([toolWithPlaceholder]);

    await new Promise<void>((resolve) => {
      middleware.run(input, agent).subscribe({
        next: () => {},
        complete: () => resolve(),
      });
    });

    // Should have warned about incompatible combination
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("SKIP_VALIDATION")
    );

    warnSpy.mockRestore();
  });

  it("should recognize marker object format for parameters (CopilotKit integration)", async () => {
    const events = createToolCallEvents("tool-1", "getWeather", '{"city": "NYC"}');
    const agent = new MockAgent(events);

    const middleware = secureToolsMiddleware({
      allowedTools: [weatherToolSpec],
    });

    // Tool with marker object format for parameters
    // This is how CopilotKit's createToolSchema outputs DEFINED_IN_MIDDLEWARE_EXPERIMENTAL
    // Note: description must match weatherToolSpec exactly since we're only using marker for parameters
    const toolWithMarkerObject: Tool = {
      name: "getWeather",
      description: "Get current weather for a city", // Must match weatherToolSpec
      parameters: { __definedInMiddleware: DEFINED_IN_MIDDLEWARE_EXPERIMENTAL } as unknown as Record<string, unknown>,
    };

    const input = createInput([toolWithMarkerObject]);
    const collectedEvents: BaseEvent[] = [];

    await new Promise<void>((resolve) => {
      middleware.run(input, agent).subscribe({
        next: (event) => collectedEvents.push(event),
        complete: () => resolve(),
      });
    });

    // Tool should be allowed after transformation (parameters replaced from spec)
    expect(collectedEvents.length).toBe(6);
  });
});

// =============================================================================
// createSecureToolHooks TESTS
// =============================================================================

import { createSecureToolHooks, type TypedToolSpec, type SecureToolHooks } from "@/middleware/secure-tools";

// We'll use a mock Zod-like schema for testing
// In real usage, you'd import z from "zod"
const mockZodSchema = {
  _output: {} as { city: string },
  parse: (data: unknown) => data as { city: string },
};

describe("createSecureToolHooks", () => {
  const toolSpecs = {
    getWeather: {
      name: "getWeather" as const,
      description: "Get current weather for a city",
      parameters: mockZodSchema,
    },
    calculator: {
      name: "calculator" as const,
      description: "Perform arithmetic operations",
      parameters: {
        _output: {} as { a: number; b: number; operation: string },
        parse: (data: unknown) => data as { a: number; b: number; operation: string },
      },
    },
  } as const;

  let hooks: SecureToolHooks<typeof toolSpecs>;

  beforeEach(() => {
    hooks = createSecureToolHooks(toolSpecs);
  });

  describe("getToolSpec", () => {
    it("should return the correct tool spec by name", () => {
      const spec = hooks.getToolSpec("getWeather");
      expect(spec.name).toBe("getWeather");
      expect(spec.description).toBe("Get current weather for a city");
      expect(spec.parameters).toBe(mockZodSchema);
    });

    it("should throw for non-existent tool name", () => {
      // @ts-expect-error - testing invalid name
      expect(() => hooks.getToolSpec("nonExistent")).toThrow(
        /Tool "nonExistent" not found in toolSpecs/
      );
    });
  });

  describe("getMiddlewareConfig", () => {
    it("should return allowedTools array with correct specs", () => {
      const config = hooks.getMiddlewareConfig();
      
      expect(config.allowedTools).toHaveLength(2);
      expect(config.allowedTools).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "getWeather",
            description: "Get current weather for a city",
          }),
          expect.objectContaining({
            name: "calculator",
            description: "Perform arithmetic operations",
          }),
        ])
      );
    });

    it("should use SKIP_VALIDATION for parameters in middleware config", () => {
      const config = hooks.getMiddlewareConfig();
      
      // Parameters use SKIP_VALIDATION because Zod schemas can't be compared to JSON schemas
      // Type safety is enforced by the Zod schema on the client side
      const weatherSpec = config.allowedTools.find((t) => t.name === "getWeather");
      expect(weatherSpec?.parameters).toBe(SKIP_VALIDATION);
    });
  });

  describe("createFrontendToolConfig", () => {
    it("should create a complete tool config with injected values", () => {
      const handler = jest.fn();
      
      const config = hooks.createFrontendToolConfig("getWeather", {
        handler,
      });

      expect(config.name).toBe("getWeather");
      expect(config.description).toBe("Get current weather for a city");
      expect(config.parameters).toBe(mockZodSchema);
      expect(config.handler).toBe(handler);
    });

    it("should include optional render function", () => {
      const handler = jest.fn();
      const render = jest.fn();

      const config = hooks.createFrontendToolConfig("getWeather", {
        handler,
        render,
      });

      expect(config.render).toBe(render);
    });

    it("should include optional agentId", () => {
      const handler = jest.fn();

      const config = hooks.createFrontendToolConfig("getWeather", {
        handler,
        agentId: "my-agent",
      });

      expect(config.agentId).toBe("my-agent");
    });

    it("should throw for non-existent tool name", () => {
      const handler = jest.fn();

      // @ts-expect-error - testing invalid name
      expect(() => hooks.createFrontendToolConfig("nonExistent", { handler })).toThrow(
        /Tool "nonExistent" not found in toolSpecs/
      );
    });
  });

  describe("toolSpecs property", () => {
    it("should expose the original toolSpecs", () => {
      expect(hooks.toolSpecs).toBe(toolSpecs);
      expect(hooks.toolSpecs.getWeather.name).toBe("getWeather");
    });
  });

  describe("integration with secureToolsMiddleware", () => {
    it("should work with middleware using getMiddlewareConfig", async () => {
      const events = createToolCallEvents("tool-1", "getWeather", '{"city": "NYC"}');
      const agent = new MockAgent(events);

      // Create tool with values from createFrontendToolConfig
      const toolConfig = hooks.createFrontendToolConfig("getWeather", {
        handler: async () => ({ temp: 72 }),
      });

      // The tool as it would appear after passing through CopilotKit
      // CopilotKit converts Zod schemas to JSON schema, which is different from the
      // original Zod schema. That's why getMiddlewareConfig uses SKIP_VALIDATION for params.
      const tool: Tool = {
        name: toolConfig.name,
        description: toolConfig.description,
        parameters: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      };

      // Use getMiddlewareConfig() for middleware setup
      // Parameters use SKIP_VALIDATION because Zod can't be compared to JSON schema
      const middleware = secureToolsMiddleware({
        ...hooks.getMiddlewareConfig(),
      });

      const input = createInput([tool]);
      const collectedEvents: BaseEvent[] = [];

      await new Promise<void>((resolve) => {
        middleware.run(input, agent).subscribe({
          next: (event) => collectedEvents.push(event),
          complete: () => resolve(),
        });
      });

      // All events should pass through (tool is in allowedTools - name and description match)
      expect(collectedEvents.length).toBe(6);
    });

    it("should block tools not in the shared specs", async () => {
      const events = createToolCallEvents("tool-1", "unknownTool", '{}');
      const agent = new MockAgent(events);

      // Tool not in our shared specs
      const unknownTool: Tool = {
        name: "unknownTool",
        description: "Some unknown tool",
        parameters: {},
      };

      const deviations: ToolDeviation[] = [];
      const middleware = secureToolsMiddleware({
        ...hooks.getMiddlewareConfig(),
        onDeviation: (deviation) => {
          deviations.push(deviation);
        },
      });

      const input = createInput([unknownTool]);
      const collectedEvents: BaseEvent[] = [];

      await new Promise<void>((resolve) => {
        middleware.run(input, agent).subscribe({
          next: (event) => collectedEvents.push(event),
          complete: () => resolve(),
        });
      });

      // Only RUN_STARTED and RUN_FINISHED should pass through
      expect(collectedEvents.length).toBe(2);
      expect(deviations.length).toBe(1);
      expect(deviations[0].reason).toBe("NOT_IN_ALLOWLIST");
    });
  });
});

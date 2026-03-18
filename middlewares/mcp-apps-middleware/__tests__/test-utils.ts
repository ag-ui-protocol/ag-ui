/* eslint-disable @typescript-eslint/no-unused-vars */
import { vi } from "vitest";
import { AbstractAgent, BaseEvent, EventType, RunAgentInput, Message, Tool, AssistantMessage } from "@ag-ui/client";
import { Observable } from "rxjs";
import { firstValueFrom, toArray } from "rxjs";

/**
 * Mock MCP Client instance
 */
export interface MockMCPClientInstance {
  connect: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  listTools: ReturnType<typeof vi.fn>;
  callTool: ReturnType<typeof vi.fn>;
  readResource: ReturnType<typeof vi.fn>;
  notification: ReturnType<typeof vi.fn>;
  ping: ReturnType<typeof vi.fn>;
}

/**
 * Create a mock MCP Client instance
 */
export function createMockMCPClient(): MockMCPClientInstance {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue({ tools: [] }),
    callTool: vi.fn().mockResolvedValue({ content: [] }),
    readResource: vi.fn().mockResolvedValue({ contents: [] }),
    notification: vi.fn().mockResolvedValue(undefined),
    ping: vi.fn().mockResolvedValue({}),
  };
}

/**
 * Mock MCP tool with UI resource (per SEP-1865)
 */
export interface MockMCPTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

/**
 * Create an MCP tool with UI resource attached
 */
export function createMCPToolWithUI(
  name: string,
  resourceUri: string,
  description?: string
): MockMCPTool {
  return {
    name,
    description: description || `Tool ${name}`,
    inputSchema: { type: "object", properties: {} },
    _meta: { "ui/resourceUri": resourceUri },
  };
}

/**
 * Create an MCP tool without UI resource
 */
export function createMCPToolWithoutUI(name: string, description?: string): MockMCPTool {
  return {
    name,
    description: description || `Tool ${name}`,
    inputSchema: { type: "object", properties: {} },
  };
}

/**
 * Create an MCP tool with _meta but no ui/resourceUri
 */
export function createMCPToolWithEmptyMeta(name: string): MockMCPTool {
  return {
    name,
    description: `Tool ${name}`,
    inputSchema: { type: "object", properties: {} },
    _meta: { someOtherField: "value" },
  };
}

/**
 * Mock Agent for testing middleware
 */
export class MockAgent extends AbstractAgent {
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
 * Mock Agent that emits events asynchronously
 */
export class AsyncMockAgent extends AbstractAgent {
  private events: BaseEvent[];
  private delayMs: number;

  constructor(events: BaseEvent[] = [], delayMs: number = 0) {
    super();
    this.events = events;
    this.delayMs = delayMs;
  }

  run(_input: RunAgentInput): Observable<BaseEvent> {
    return new Observable((subscriber) => {
      let cancelled = false;

      const emitEvents = async () => {
        for (const event of this.events) {
          if (cancelled) break;
          if (this.delayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, this.delayMs));
          }
          if (!cancelled) {
            subscriber.next(event);
          }
        }
        if (!cancelled) {
          subscriber.complete();
        }
      };

      emitEvents();

      return () => {
        cancelled = true;
      };
    });
  }
}

/**
 * Mock Agent that throws an error
 */
export class ErrorMockAgent extends AbstractAgent {
  private error: Error;

  constructor(error: Error = new Error("Mock error")) {
    super();
    this.error = error;
  }

  run(_input: RunAgentInput): Observable<BaseEvent> {
    return new Observable((subscriber) => {
      subscriber.error(this.error);
    });
  }
}

/**
 * Create a basic RunAgentInput for testing
 */
export function createRunAgentInput(overrides: Partial<RunAgentInput> = {}): RunAgentInput {
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
 * Create a RUN_STARTED event
 */
export function createRunStartedEvent(
  runId: string = "test-run",
  threadId: string = "test-thread"
): BaseEvent {
  return {
    type: EventType.RUN_STARTED,
    runId,
    threadId,
  };
}

/**
 * Create a RUN_FINISHED event
 */
export function createRunFinishedEvent(
  runId: string = "test-run",
  threadId: string = "test-thread",
  result?: unknown
): BaseEvent {
  return {
    type: EventType.RUN_FINISHED,
    runId,
    threadId,
    result,
  };
}

/**
 * Create a TEXT_MESSAGE_START event
 */
export function createTextMessageStartEvent(messageId: string = "msg-1"): BaseEvent {
  return {
    type: EventType.TEXT_MESSAGE_START,
    messageId,
    role: "assistant",
  };
}

/**
 * Create a TEXT_MESSAGE_CONTENT event
 */
export function createTextMessageContentEvent(
  messageId: string = "msg-1",
  delta: string = "Hello"
): BaseEvent {
  return {
    type: EventType.TEXT_MESSAGE_CONTENT,
    messageId,
    delta,
  };
}

/**
 * Create a TEXT_MESSAGE_END event
 */
export function createTextMessageEndEvent(messageId: string = "msg-1"): BaseEvent {
  return {
    type: EventType.TEXT_MESSAGE_END,
    messageId,
  };
}

/**
 * Create a TOOL_CALL_START event
 */
export function createToolCallStartEvent(
  toolCallId: string,
  toolCallName: string,
  parentMessageId?: string
): BaseEvent {
  return {
    type: EventType.TOOL_CALL_START,
    toolCallId,
    toolCallName,
    parentMessageId,
  };
}

/**
 * Create a TOOL_CALL_ARGS event
 */
export function createToolCallArgsEvent(toolCallId: string, delta: string): BaseEvent {
  return {
    type: EventType.TOOL_CALL_ARGS,
    toolCallId,
    delta,
  };
}

/**
 * Create a TOOL_CALL_END event
 */
export function createToolCallEndEvent(toolCallId: string): BaseEvent {
  return {
    type: EventType.TOOL_CALL_END,
    toolCallId,
  };
}

/**
 * Create a TOOL_CALL_RESULT event
 */
export function createToolCallResultEvent(
  toolCallId: string,
  content: string,
  messageId: string = `result-${toolCallId}`
): BaseEvent {
  return {
    type: EventType.TOOL_CALL_RESULT,
    messageId,
    toolCallId,
    content,
  };
}

/**
 * Create an assistant message with tool calls
 */
export function createAssistantMessageWithToolCalls(
  toolCalls: Array<{ name: string; args?: Record<string, unknown>; id?: string }>,
  messageId?: string
): AssistantMessage {
  return {
    id: messageId || `msg-${Math.random().toString(36).substr(2, 9)}`,
    role: "assistant",
    content: "",
    toolCalls: toolCalls.map((tc) => ({
      id: tc.id || `tc-${Math.random().toString(36).substr(2, 9)}`,
      type: "function" as const,
      function: {
        name: tc.name,
        arguments: JSON.stringify(tc.args || {}),
      },
    })),
  };
}

/**
 * Create a tool result message
 */
export function createToolResultMessage(
  toolCallId: string,
  content: string,
  messageId?: string
): Message {
  return {
    id: messageId || `msg-${Math.random().toString(36).substr(2, 9)}`,
    role: "tool",
    toolCallId,
    content,
  };
}

/**
 * Create an AG-UI Tool
 */
export function createAGUITool(name: string, description?: string): Tool {
  return {
    name,
    description: description || `Tool ${name}`,
    parameters: { type: "object", properties: {} },
  };
}

/**
 * Collect all events from an Observable
 */
export async function collectEvents(observable: Observable<BaseEvent>): Promise<BaseEvent[]> {
  return firstValueFrom(observable.pipe(toArray()));
}

/**
 * Create MCP tool call result (what callTool returns)
 */
export function createMCPToolCallResult(
  content: Array<{ type: string; text?: string; [key: string]: unknown }>
): { content: Array<{ type: string; text?: string; [key: string]: unknown }> } {
  return { content };
}

/**
 * Create MCP resource read result
 */
export function createMCPResourceResult(
  uri: string,
  mimeType: string,
  text: string
): { contents: Array<{ uri: string; mimeType: string; text: string }> } {
  return {
    contents: [{ uri, mimeType, text }],
  };
}

/**
 * Wait for a condition to be true
 */
export async function waitForCondition(
  condition: () => boolean,
  timeout: number = 1000,
  interval: number = 10
): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeout) {
      throw new Error("Timeout waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

/**
 * Generate a random UUID-like string
 */
export function randomId(): string {
  return `${Math.random().toString(36).substr(2, 9)}-${Math.random().toString(36).substr(2, 9)}`;
}

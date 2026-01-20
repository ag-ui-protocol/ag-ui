import { randomUUID } from "node:crypto";
import {
  Middleware,
  RunAgentInput,
  AbstractAgent,
  BaseEvent,
  EventType,
  Message,
  AssistantMessage,
  ToolMessage,
  ActivitySnapshotEvent,
  ToolCallResultEvent,
  ToolCallEndEvent,
  ToolCallStartEvent,
  ToolCallArgsEvent,
} from "@ag-ui/client";
import { Observable, of, from } from "rxjs";
import { concatMap } from "rxjs/operators";

import {
  A2UIMiddlewareConfig,
  A2UIForwardedProps,
  A2UIUserAction,
} from "./types";
import { SEND_A2UI_JSON_TOOL, SEND_A2UI_TOOL_NAME, LOG_A2UI_EVENT_TOOL_NAME } from "./tools";
import {
  getSystemPromptWarning,
  extractSurfaceIds,
} from "./schema";

// Re-exports
export * from "./types";
export * from "./tools";
export * from "./schema";

/**
 * Activity type for A2UI surface events
 */
export const A2UIActivityType = "a2ui-surface";

/**
 * A2UI Middleware - Enables AG-UI agents to render A2UI surfaces
 * and handles bidirectional communication of user actions.
 */
export class A2UIMiddleware extends Middleware {
  private config: A2UIMiddlewareConfig;

  constructor(config: A2UIMiddlewareConfig = {}) {
    super();
    this.config = config;

    // Log warning if systemInstructionsAdded is not set
    if (!config.systemInstructionsAdded) {
      console.warn(getSystemPromptWarning());
    }
  }

  /**
   * Main middleware run method
   */
  run(input: RunAgentInput, next: AbstractAgent): Observable<BaseEvent> {
    // Process user action from forwardedProps (prepend synthetic messages)
    const enhancedInput = this.processUserAction(input);

    // Inject the send_a2ui_json_to_client tool
    const inputWithTool = this.injectTool(enhancedInput);

    // Process the event stream
    return this.processEventStream(inputWithTool, next);
  }

  /**
   * Check forwardedProps for a2uiAction and prepend synthetic tool call messages
   */
  private processUserAction(input: RunAgentInput): RunAgentInput {
    const forwardedProps = input.forwardedProps as A2UIForwardedProps | undefined;
    const userAction = forwardedProps?.a2uiAction?.userAction;

    if (!userAction) {
      return input;
    }

    // Generate IDs for the synthetic messages
    const assistantMessageId = randomUUID();
    const toolCallId = randomUUID();
    const toolMessageId = randomUUID();

    // Create synthetic assistant message with tool call
    const syntheticAssistantMessage: AssistantMessage = {
      id: assistantMessageId,
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: toolCallId,
          type: "function",
          function: {
            name: LOG_A2UI_EVENT_TOOL_NAME,
            arguments: JSON.stringify(userAction),
          },
        },
      ],
    };

    // Create synthetic tool result message
    const resultContent = this.formatUserActionResult(userAction);
    const syntheticToolMessage: ToolMessage = {
      id: toolMessageId,
      role: "tool",
      toolCallId: toolCallId,
      content: resultContent,
    };

    // Append synthetic messages to existing messages (so they appear as the latest action)
    const messages: Message[] = [
      ...(input.messages || []),
      syntheticAssistantMessage,
      syntheticToolMessage,
    ];

    return {
      ...input,
      messages,
    };
  }

  /**
   * Format the user action result message for the agent
   */
  private formatUserActionResult(action: A2UIUserAction): string {
    const actionName = action.name ?? "unknown_action";
    const surfaceId = action.surfaceId ?? "unknown_surface";
    const componentId = action.sourceComponentId;
    const contextStr = action.context ? JSON.stringify(action.context) : "{}";

    let message = `User performed action "${actionName}" on surface "${surfaceId}"`;
    if (componentId) {
      message += ` (component: ${componentId})`;
    }
    message += `. Context: ${contextStr}`;
    return message;
  }

  /**
   * Inject the send_a2ui_json_to_client tool into the input
   */
  private injectTool(input: RunAgentInput): RunAgentInput {
    // Check if tool already exists
    const toolExists = input.tools.some((t) => t.name === SEND_A2UI_TOOL_NAME);
    if (toolExists) {
      return input;
    }

    return {
      ...input,
      tools: [...input.tools, SEND_A2UI_JSON_TOOL],
    };
  }

  /**
   * Process the event stream, intercepting tool calls for send_a2ui_json_to_client
   *
   * This implementation tracks tool calls directly from the event stream to handle
   * cases where TOOL_CALL_START events are not emitted (e.g., some CopilotKit runtimes).
   */
  private processEventStream(
    input: RunAgentInput,
    next: AbstractAgent
  ): Observable<BaseEvent> {
    // Track tool calls by ID: { toolCallId -> { name?, args } }
    const toolCallTracker = new Map<string, { name?: string; args: string }>();

    return this.runNext(input, next).pipe(
      concatMap((event) => {
        switch (event.type) {
          case EventType.TOOL_CALL_START: {
            // Track the tool name when TOOL_CALL_START is emitted
            const startEvent = event as ToolCallStartEvent;
            toolCallTracker.set(startEvent.toolCallId, {
              name: startEvent.toolCallName,
              args: "",
            });
            return of(event);
          }

          case EventType.TOOL_CALL_ARGS: {
            // Accumulate arguments for the tool call
            const argsEvent = event as ToolCallArgsEvent;
            const tracker = toolCallTracker.get(argsEvent.toolCallId);
            if (tracker) {
              tracker.args += argsEvent.delta;
            } else {
              // TOOL_CALL_START was not emitted - create tracker without name
              toolCallTracker.set(argsEvent.toolCallId, {
                name: undefined,
                args: argsEvent.delta,
              });
            }
            return of(event);
          }

          case EventType.TOOL_CALL_END: {
            const endEvent = event as ToolCallEndEvent;
            const tracker = toolCallTracker.get(endEvent.toolCallId);

            // Clean up tracker
            toolCallTracker.delete(endEvent.toolCallId);

            if (!tracker) {
              return of(event);
            }

            // Check if this is our tool - either by name or by detecting a2ui_json in args
            const isOurTool = this.isA2UIToolCall(tracker.name, tracker.args);

            if (!isOurTool) {
              return of(event);
            }

            // Process the tool call and emit additional events
            const { activityEvent, resultEvent } = this.processSendA2UIToolCall(
              endEvent.toolCallId,
              tracker.args
            );

            // Emit activity snapshot, tool result, then original end event
            return from([activityEvent, resultEvent, event]);
          }

          default:
            return of(event);
        }
      })
    );
  }

  /**
   * Check if a tool call is for our send_a2ui_json_to_client tool.
   * Uses both the tool name (if available) and argument detection.
   */
  private isA2UIToolCall(toolName: string | undefined, args: string): boolean {
    // If we have the tool name, use it
    if (toolName === SEND_A2UI_TOOL_NAME) {
      return true;
    }

    // If tool name is not available (no TOOL_CALL_START), try to detect from args
    // Our tool expects { a2ui_json: "..." } so we look for that pattern
    if (!toolName) {
      try {
        const parsed = JSON.parse(args);
        if (typeof parsed === "object" && parsed !== null && "a2ui_json" in parsed) {
          return true;
        }
      } catch {
        // Not valid JSON yet or not our tool
      }
    }

    return false;
  }

  /**
   * Process a completed send_a2ui_json_to_client tool call
   */
  private processSendA2UIToolCall(
    toolCallId: string,
    argsInput: string | Record<string, unknown>
  ): {
    activityEvent: ActivitySnapshotEvent;
    resultEvent: ToolCallResultEvent;
  } {
    const messageId = randomUUID();

    // Parse the tool arguments - argsInput can be string or object (CopilotKit gives object)
    let args: { a2ui_json?: string | Array<Record<string, unknown>> | Record<string, unknown> } = {};
    if (typeof argsInput === "string") {
      try {
        args = JSON.parse(argsInput || "{}");
      } catch (e) {
        console.warn("[A2UIMiddleware] Failed to parse tool call arguments:", e);
      }
    } else if (typeof argsInput === "object" && argsInput !== null) {
      args = argsInput as { a2ui_json?: string };
    }

    // a2ui_json can be either:
    // 1. A string containing JSON array of A2UI messages (needs parsing)
    // 2. An array of A2UI messages directly (no parsing needed - structured output)
    // 3. A single operation object
    const a2uiJsonValue = args.a2ui_json;

    // Parse A2UI operations (messages)
    let operations: Array<Record<string, unknown>> = [];
    let surfaceIds: string[] = [];

    if (typeof a2uiJsonValue === "string") {
      // Case 1: String that needs parsing
      try {
        const parsed = JSON.parse(a2uiJsonValue);
        if (Array.isArray(parsed)) {
          operations = parsed as Array<Record<string, unknown>>;
        } else if (typeof parsed === "object" && parsed !== null) {
          operations = [parsed as Record<string, unknown>];
        }
      } catch (e) {
        console.warn("[A2UIMiddleware] Failed to parse A2UI JSON string:", e);
      }
    } else if (Array.isArray(a2uiJsonValue)) {
      // Case 2: Already an array of operations (structured output)
      operations = a2uiJsonValue as Array<Record<string, unknown>>;
    } else if (typeof a2uiJsonValue === "object" && a2uiJsonValue !== null) {
      // Case 3: A single operation object
      operations = [a2uiJsonValue as Record<string, unknown>];
    } else {
      console.warn("[A2UIMiddleware] a2ui_json has unexpected type:", typeof a2uiJsonValue);
    }

    surfaceIds = extractSurfaceIds(operations);

    // Create ACTIVITY_SNAPSHOT event
    const activityEvent: ActivitySnapshotEvent = {
      type: EventType.ACTIVITY_SNAPSHOT,
      messageId,
      activityType: A2UIActivityType,
      content: { operations },
      replace: false,
    };

    // Create TOOL_CALL_RESULT event
    const resultEvent: ToolCallResultEvent = {
      type: EventType.TOOL_CALL_RESULT,
      messageId: randomUUID(),
      toolCallId,
      content: JSON.stringify({
        success: true,
        surfacesRendered: surfaceIds,
      }),
    };

    return { activityEvent, resultEvent };
  }
}


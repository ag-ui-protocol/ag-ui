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
  ToolCall,
  ActivitySnapshotEvent,
  ActivityDeltaEvent,
  ToolCallResultEvent,
} from "@ag-ui/client";
import { Observable } from "rxjs";

import {
  A2UIMiddlewareConfig,
  A2UIForwardedProps,
  A2UIUserAction,
} from "./types";
import { SEND_A2UI_JSON_TOOL, SEND_A2UI_TOOL_NAME, LOG_A2UI_EVENT_TOOL_NAME } from "./tools";
import { getSystemPromptWarning, getOperationSurfaceId } from "./schema";

// Re-exports
export * from "./types";
export * from "./tools";
export * from "./schema";

/**
 * Activity type for A2UI surface events
 */
export const A2UIActivityType = "a2ui-surface";

/**
 * Extract EventWithState type from Middleware.runNextWithState return type
 */
type ExtractObservableType<T> = T extends Observable<infer U> ? U : never;
type RunNextWithStateReturn = ReturnType<Middleware["runNextWithState"]>;
type EventWithState = ExtractObservableType<RunNextWithStateReturn>;

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
    // Process user action from forwardedProps (append synthetic messages)
    const enhancedInput = this.processUserAction(input);

    // Inject the send_a2ui_json_to_client tool
    const inputWithTool = this.injectTool(enhancedInput);

    // Process the event stream using runNextWithState for automatic message tracking
    return this.processStream(this.runNextWithState(inputWithTool, next));
  }

  /**
   * Check forwardedProps for a2uiAction and append synthetic tool call messages
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
   * Process the event stream, holding back RUN_FINISHED to process pending A2UI tool calls.
   * Uses runNextWithState for automatic message tracking.
   */
  private processStream(source: Observable<EventWithState>): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      let heldRunFinished: EventWithState | null = null;

      const subscription = source.subscribe({
        next: (eventWithState) => {
          const event = eventWithState.event;

          // If we have a held RUN_FINISHED and a new event comes, flush it first
          if (heldRunFinished) {
            subscriber.next(heldRunFinished.event);
            heldRunFinished = null;
          }

          // If this is a RUN_FINISHED event, hold it back
          if (event.type === EventType.RUN_FINISHED) {
            heldRunFinished = eventWithState;
          } else {
            subscriber.next(event);
          }
        },
        error: (err) => {
          // On error, flush any held event and propagate error
          if (heldRunFinished) {
            subscriber.next(heldRunFinished.event);
            heldRunFinished = null;
          }
          subscriber.error(err);
        },
        complete: () => {
          // Stream ended - process pending A2UI tool calls if we have a held RUN_FINISHED
          if (heldRunFinished) {
            // Extract known surfaces from COMPLETED tool calls in message history (stateless)
            const knownSurfaceIds = this.extractKnownSurfacesFromMessages(heldRunFinished.messages);

            // Find tool calls that don't have a corresponding result message
            const pendingToolCalls = this.findPendingToolCalls(heldRunFinished.messages);

            // Filter for A2UI tool calls
            const pendingA2UIToolCalls = pendingToolCalls.filter(
              (tc) => tc.function.name === SEND_A2UI_TOOL_NAME
            );

            // Process each pending A2UI tool call (knownSurfaceIds is updated as we process)
            for (const toolCall of pendingA2UIToolCalls) {
              const events = this.processSendA2UIToolCall(
                toolCall.id,
                toolCall.function.arguments,
                knownSurfaceIds
              );
              for (const event of events) {
                subscriber.next(event);
              }
            }

            // Emit the held RUN_FINISHED
            subscriber.next(heldRunFinished.event);
            heldRunFinished = null;
          }
          subscriber.complete();
        },
      });

      return () => subscription.unsubscribe();
    });
  }

  /**
   * Find tool calls that don't have a corresponding result (role: "tool") message
   */
  private findPendingToolCalls(messages: Message[]): ToolCall[] {
    // Collect all tool calls from assistant messages
    const allToolCalls: ToolCall[] = [];
    for (const message of messages) {
      if (
        message.role === "assistant" &&
        "toolCalls" in message &&
        message.toolCalls
      ) {
        allToolCalls.push(...message.toolCalls);
      }
    }

    // Collect all tool call IDs that have results
    const resolvedToolCallIds = new Set<string>();
    for (const message of messages) {
      if (message.role === "tool" && "toolCallId" in message) {
        resolvedToolCallIds.add(message.toolCallId);
      }
    }

    // Return tool calls that don't have results
    return allToolCalls.filter((tc) => !resolvedToolCallIds.has(tc.id));
  }

  /**
   * Extract surface IDs from COMPLETED A2UI tool calls in message history.
   * This is stateless - we derive known surfaces from the conversation history.
   */
  private extractKnownSurfacesFromMessages(messages: Message[]): Set<string> {
    const knownSurfaceIds = new Set<string>();

    // Find all tool call IDs that have results (completed tool calls)
    const completedToolCallIds = new Set<string>();
    for (const message of messages) {
      if (message.role === "tool" && "toolCallId" in message) {
        completedToolCallIds.add(message.toolCallId);
      }
    }

    // Find completed A2UI tool calls and extract their surface IDs
    for (const message of messages) {
      if (
        message.role === "assistant" &&
        "toolCalls" in message &&
        message.toolCalls
      ) {
        for (const toolCall of message.toolCalls) {
          // Only process completed A2UI tool calls
          if (
            toolCall.function.name === SEND_A2UI_TOOL_NAME &&
            completedToolCallIds.has(toolCall.id)
          ) {
            // Extract surface IDs from the tool call arguments
            const surfaceIds = this.extractSurfaceIdsFromToolCall(toolCall);
            for (const surfaceId of surfaceIds) {
              knownSurfaceIds.add(surfaceId);
            }
          }
        }
      }
    }

    return knownSurfaceIds;
  }

  /**
   * Extract surface IDs from a tool call's arguments
   */
  private extractSurfaceIdsFromToolCall(toolCall: ToolCall): string[] {
    const surfaceIds: string[] = [];

    try {
      // Parse the tool call arguments
      let args: { a2ui_json?: string | Array<Record<string, unknown>> | Record<string, unknown> } = {};
      const argsInput = toolCall.function.arguments;

      if (typeof argsInput === "string") {
        args = JSON.parse(argsInput || "{}");
      } else if (typeof argsInput === "object" && argsInput !== null) {
        args = argsInput as { a2ui_json?: string };
      }

      // Parse the A2UI operations
      const a2uiJsonValue = args.a2ui_json;
      let operations: Array<Record<string, unknown>> = [];

      if (typeof a2uiJsonValue === "string") {
        const parsed = JSON.parse(a2uiJsonValue);
        if (Array.isArray(parsed)) {
          operations = parsed;
        } else if (typeof parsed === "object" && parsed !== null) {
          operations = [parsed];
        }
      } else if (Array.isArray(a2uiJsonValue)) {
        operations = a2uiJsonValue;
      } else if (typeof a2uiJsonValue === "object" && a2uiJsonValue !== null) {
        operations = [a2uiJsonValue];
      }

      // Extract surface IDs from operations
      for (const op of operations) {
        const surfaceId = getOperationSurfaceId(op);
        if (surfaceId) {
          surfaceIds.push(surfaceId);
        }
      }
    } catch {
      // Ignore parse errors
    }

    return surfaceIds;
  }

  /**
   * Process a completed send_a2ui_json_to_client tool call.
   * Returns an array of events: activity events (SNAPSHOT or DELTA) per surface + a tool result.
   * Updates existingSurfaceIds as surfaces are created.
   */
  private processSendA2UIToolCall(
    toolCallId: string,
    argsInput: string | Record<string, unknown>,
    existingSurfaceIds: Set<string>
  ): BaseEvent[] {
    const events: BaseEvent[] = [];

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

    // Group operations by surfaceId
    const operationsBySurface = new Map<string, Array<Record<string, unknown>>>();
    for (const op of operations) {
      const surfaceId = getOperationSurfaceId(op) ?? "default";
      if (!operationsBySurface.has(surfaceId)) {
        operationsBySurface.set(surfaceId, []);
      }
      operationsBySurface.get(surfaceId)!.push(op);
    }

    // Emit events per surface
    for (const [surfaceId, surfaceOps] of operationsBySurface) {
      const messageId = `a2ui-surface-${surfaceId}`;

      if (!existingSurfaceIds.has(surfaceId)) {
        // New surface - emit ACTIVITY_SNAPSHOT
        existingSurfaceIds.add(surfaceId);
        const activityEvent: ActivitySnapshotEvent = {
          type: EventType.ACTIVITY_SNAPSHOT,
          messageId,
          activityType: A2UIActivityType,
          content: { operations: surfaceOps },
          replace: false,
        };
        events.push(activityEvent);
      } else {
        // Existing surface - emit ACTIVITY_DELTA to append operations
        const deltaEvent: ActivityDeltaEvent = {
          type: EventType.ACTIVITY_DELTA,
          messageId,
          activityType: A2UIActivityType,
          patch: surfaceOps.map((op) => ({
            op: "add" as const,
            path: "/operations/-",
            value: op,
          })),
        };
        events.push(deltaEvent);
      }
    }

    // Create TOOL_CALL_RESULT event
    const resultEvent: ToolCallResultEvent = {
      type: EventType.TOOL_CALL_RESULT,
      messageId: randomUUID(),
      toolCallId,
      content: JSON.stringify({
        success: true,
        surfacesRendered: Array.from(operationsBySurface.keys()),
      }),
    };
    events.push(resultEvent);

    return events;
  }
}

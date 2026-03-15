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
  ToolCallStartEvent,
  ToolCallArgsEvent,
} from "@ag-ui/client";
import { Observable } from "rxjs";

import {
  A2UIMiddlewareConfig,
  A2UIForwardedProps,
  A2UIUserAction,
  A2UISurfaceConfig,
} from "./types";
import { SEND_A2UI_JSON_TOOL, SEND_A2UI_TOOL_NAME, LOG_A2UI_EVENT_TOOL_NAME } from "./tools";
import { getOperationSurfaceId, tryParseA2UIOperations, A2UI_OPERATIONS_KEY, toA2UIContents, extractCompleteItems } from "./schema";

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
 * Emit a streaming data snapshot for an A2UI surface.
 */
function emitStreamingData(
  subscriber: { next: (event: BaseEvent) => void },
  schema: A2UISurfaceConfig,
  dataKey: string,
  items: unknown[],
  toolCallId: string,
) {
  const surfaceId = schema.surfaceId;
  const messageId = `a2ui-surface-${surfaceId}-${toolCallId}`;
  const contents = toA2UIContents({ [dataKey]: items });
  const allOps = [
    { surfaceUpdate: { surfaceId, components: schema.components } },
    { dataModelUpdate: { surfaceId, contents } },
    { beginRendering: { surfaceId, root: schema.root } },
  ];
  const content: Record<string, unknown> = { operations: allOps };
  if (schema.actionHandlers) {
    content.actionHandlers = schema.actionHandlers;
  }
  const snapshotEvent: ActivitySnapshotEvent = {
    type: EventType.ACTIVITY_SNAPSHOT,
    messageId,
    activityType: A2UIActivityType,
    content,
    replace: true,
  };
  subscriber.next(snapshotEvent);
}

/**
 * A2UI Middleware - Enables AG-UI agents to render A2UI surfaces
 * and handles bidirectional communication of user actions.
 */
export class A2UIMiddleware extends Middleware {
  private config: A2UIMiddlewareConfig;

  constructor(config: A2UIMiddlewareConfig = {}) {
    super();
    this.config = config;
  }

  /**
   * Main middleware run method
   */
  run(input: RunAgentInput, next: AbstractAgent): Observable<BaseEvent> {
    // Process user action from forwardedProps (append synthetic messages)
    const enhancedInput = this.processUserAction(input);

    // Conditionally inject the send_a2ui_json_to_client tool
    const finalInput = this.config.injectA2UITool
      ? this.injectTool(enhancedInput)
      : enhancedInput;

    // Process the event stream using runNextWithState for automatic message tracking
    return this.processStream(this.runNextWithState(finalInput, next));
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
   * Inject the send_a2ui_json_to_client tool into the input.
   * Always replaces the tool schema if it already exists, because frontend-registered
   * tools may have a broken schema (e.g., Zod v4 schemas fail zod-to-json-schema v3 conversion,
   * producing an empty { type: "object", properties: {} } with no a2ui_json property).
   */
  private injectTool(input: RunAgentInput): RunAgentInput {
    // Replace existing tool with our well-defined schema, or add if not present
    const filteredTools = input.tools.filter((t) => t.name !== SEND_A2UI_TOOL_NAME);
    return {
      ...input,
      tools: [...filteredTools, SEND_A2UI_JSON_TOOL],
    };
  }

  /**
   * Process the event stream, holding back RUN_FINISHED to process pending A2UI tool calls.
   * Uses runNextWithState for automatic message tracking.
   *
   * For tools with registered streaming surfaces, emits surfaceUpdate + beginRendering
   * on TOOL_CALL_START and streams dataModelUpdate as args are generated.
   */
  private processStream(source: Observable<EventWithState>): Observable<BaseEvent> {
    // Build lookup: toolName → surface config
    const surfacesByTool = new Map<string, A2UISurfaceConfig>();
    for (const entry of this.config.streamingSurfaces ?? []) {
      surfacesByTool.set(entry.toolName, entry.surface);
    }

    return new Observable<BaseEvent>((subscriber) => {
      let heldRunFinished: EventWithState | null = null;
      // Track tool call IDs belonging to send_a2ui_json_to_client so we skip them
      const a2uiToolCallIds = new Set<string>();
      // Track streaming A2UI tool calls
      const streamingToolCalls = new Map<string, {
        schema: A2UISurfaceConfig;
        args: string;
        emittedCount: number;
      }>();

      const subscription = source.subscribe({
        next: (eventWithState) => {
          const event = eventWithState.event;

          // Track send_a2ui_json_to_client tool call IDs from TOOL_CALL_START events
          if (event.type === EventType.TOOL_CALL_START) {
            const startEvent = event as ToolCallStartEvent;
            if (startEvent.toolCallName === SEND_A2UI_TOOL_NAME) {
              a2uiToolCallIds.add(startEvent.toolCallId);
            }

            // Check if this tool has a registered streaming surface
            const schema = surfacesByTool.get(startEvent.toolCallName);
            if (schema) {
              // Track this tool call for streaming
              streamingToolCalls.set(startEvent.toolCallId, { schema, args: "", emittedCount: 0 });

              // Emit schema immediately: surfaceUpdate + beginRendering + actionHandlers
              const schemaOps = [
                { surfaceUpdate: { surfaceId: schema.surfaceId, components: schema.components } },
                { beginRendering: { surfaceId: schema.surfaceId, root: schema.root } },
              ];
              for (const activityEvent of this.createA2UIActivityEvents(
                schemaOps,
                schema.actionHandlers,
                startEvent.toolCallId,
              )) {
                subscriber.next(activityEvent);
              }
            }
          }

          // Stream data updates as tool args come in
          if (event.type === EventType.TOOL_CALL_ARGS) {
            const argsEvent = event as ToolCallArgsEvent;
            const streaming = streamingToolCalls.get(argsEvent.toolCallId);
            if (streaming) {
              streaming.args += argsEvent.delta;
              const dataKey = streaming.schema.dataKey;

              // Extract complete items from partial JSON (e.g. complete flight objects)
              const items = extractCompleteItems(streaming.args, dataKey);
              if (items && items.length > streaming.emittedCount) {
                streaming.emittedCount = items.length;
                emitStreamingData(subscriber, streaming.schema, dataKey, items, argsEvent.toolCallId);
              }
            }
          }

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

            // Auto-detect A2UI JSON in tool call results from other tools
            if (event.type === EventType.TOOL_CALL_RESULT) {
              const resultEvent = event as ToolCallResultEvent;
              // Skip if this is a streaming tool call (already handled) or send_a2ui tool
              if (!a2uiToolCallIds.has(resultEvent.toolCallId) &&
                  !streamingToolCalls.has(resultEvent.toolCallId)) {
                const parsed = tryParseA2UIOperations(resultEvent.content);
                if (parsed) {
                  for (const activityEvent of this.createA2UIActivityEvents(
                    parsed.operations,
                    parsed.actionHandlers,
                    resultEvent.toolCallId,
                  )) {
                    subscriber.next(activityEvent);
                  }
                }
              }
            }
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
          if (heldRunFinished) {
            const pendingToolCalls = this.findPendingToolCalls(heldRunFinished.messages);
            const pendingA2UIToolCalls = pendingToolCalls.filter(
              (tc) => tc.function.name === SEND_A2UI_TOOL_NAME
            );
            for (const toolCall of pendingA2UIToolCalls) {
              const events = this.processSendA2UIToolCall(
                toolCall.id,
                toolCall.function.arguments
              );
              for (const event of events) {
                subscriber.next(event);
              }
            }
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
   * Process a completed send_a2ui_json_to_client tool call.
   * Returns an array of events: ACTIVITY_DELTA + ACTIVITY_SNAPSHOT per surface + a tool result.
   *
   * Always emits both events for each surface:
   * 1. ACTIVITY_DELTA first - appends if message exists, no-op if not
   * 2. ACTIVITY_SNAPSHOT with replace: false - creates if message doesn't exist, ignored if it does
   */
  private processSendA2UIToolCall(
    toolCallId: string,
    argsInput: string | Record<string, unknown>
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

    // Create activity events from the parsed operations
    events.push(...this.createA2UIActivityEvents(operations, undefined, toolCallId));

    // Create TOOL_CALL_RESULT event
    const resultEvent: ToolCallResultEvent = {
      type: EventType.TOOL_CALL_RESULT,
      messageId: randomUUID(),
      toolCallId,
      content: JSON.stringify(operations),
    };
    events.push(resultEvent);

    return events;
  }

  /**
   * Create ACTIVITY_DELTA + ACTIVITY_SNAPSHOT events from A2UI operations,
   * grouped by surfaceId.
   *
   * @param operations - A2UI operations to emit
   * @param actionHandlers - Optional pre-declared action handlers
   * @param toolCallId - Unique tool call ID to isolate surfaces between invocations
   */
  private createA2UIActivityEvents(
    operations: Array<Record<string, unknown>>,
    actionHandlers?: Record<string, Array<Record<string, unknown>>>,
    toolCallId?: string,
  ): BaseEvent[] {
    const events: BaseEvent[] = [];

    // Group operations by surfaceId
    const operationsBySurface = new Map<string, Array<Record<string, unknown>>>();
    for (const op of operations) {
      const surfaceId = getOperationSurfaceId(op) ?? "default";
      if (!operationsBySurface.has(surfaceId)) {
        operationsBySurface.set(surfaceId, []);
      }
      operationsBySurface.get(surfaceId)!.push(op);
    }

    // Emit events per surface: always emit delta first, then snapshot
    for (const [surfaceId, surfaceOps] of operationsBySurface) {
      // Include toolCallId in messageId to ensure each tool invocation
      // creates a distinct activity message, even for the same surfaceId
      const messageId = toolCallId
        ? `a2ui-surface-${surfaceId}-${toolCallId}`
        : `a2ui-surface-${surfaceId}`;

      // 1. ACTIVITY_DELTA - appends operations if message exists, no-op if not
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

      // 2. ACTIVITY_SNAPSHOT with action handlers if provided
      const content: Record<string, unknown> = { operations: surfaceOps };
      if (actionHandlers) {
        content.actionHandlers = actionHandlers;
      }

      const snapshotEvent: ActivitySnapshotEvent = {
        type: EventType.ACTIVITY_SNAPSHOT,
        messageId,
        activityType: A2UIActivityType,
        content,
        replace: false,
      };
      events.push(snapshotEvent);
    }

    return events;
  }
}

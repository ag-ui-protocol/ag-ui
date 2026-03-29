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
import { getOperationSurfaceId, tryParseA2UIOperations, A2UI_OPERATIONS_KEY, extractCompleteItems, extractCompleteItemsWithStatus, extractCompleteA2UIOperations, extractStringField } from "./schema";

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
 * Group operations by surfaceId.
 */
function groupBySurface(ops: Array<Record<string, unknown>>): Map<string, Array<Record<string, unknown>>> {
  const groups = new Map<string, Array<Record<string, unknown>>>();
  for (const op of ops) {
    const sid = getOperationSurfaceId(op) ?? "default";
    if (!groups.has(sid)) groups.set(sid, []);
    groups.get(sid)!.push(op);
  }
  return groups;
}

/**
 * Emit a streaming data snapshot for an A2UI surface (v0.9 format).
 *
 * For fixed-schema surfaces, createSurface is already emitted at TOOL_CALL_START,
 * so `firstEmission` is false. For dynamic surfaces (render_a2ui), the surfaceId
 * isn't known until schema extraction — `firstEmission` is true on the first call
 * to include createSurface atomically with the first data snapshot.
 */
function emitStreamingData(
  subscriber: { next: (event: BaseEvent) => void },
  schema: A2UISurfaceConfig,
  dataKey: string,
  items: unknown[],
  toolCallId: string,
  dynamicActionHandlers?: Record<string, Array<Record<string, unknown>>>,
  firstEmission: boolean = false,
) {
  const surfaceId = schema.surfaceId;
  const messageId = `a2ui-surface-${surfaceId}-${toolCallId}`;
  const allOps: Array<Record<string, unknown>> = [];
  if (firstEmission) {
    allOps.push({ version: "v0.9", createSurface: { surfaceId, catalogId: schema.catalogId } });
  }
  allOps.push(
    { version: "v0.9", updateComponents: { surfaceId, components: schema.components } },
    { version: "v0.9", updateDataModel: { surfaceId, path: "/", value: { [dataKey]: items } } },
  );
  const content: Record<string, unknown> = { [A2UI_OPERATIONS_KEY]: allOps };
  // Include actionHandlers from either the fixed-schema config or dynamic extraction
  const actionHandlers = schema.actionHandlers ?? dynamicActionHandlers;
  if (actionHandlers) {
    content.actionHandlers = actionHandlers;
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

    // Inject A2UI component schema as context so agents know what components are available
    const withSchema = this.injectSchemaContext(enhancedInput);

    // Conditionally inject the send_a2ui_json_to_client tool
    const finalInput = this.config.injectA2UITool
      ? this.injectTool(withSchema)
      : withSchema;

    // Process the event stream using runNextWithState for automatic message tracking
    return this.processStream(this.runNextWithState(finalInput, next));
  }

  /**
   * Inject the A2UI component schema into RunAgentInput.context.
   * This makes the schema available to agents as a context entry,
   * similar to how useAgentContext propagates application context.
   */
  private injectSchemaContext(input: RunAgentInput): RunAgentInput {
    if (!this.config.schema || this.config.schema.length === 0) {
      return input;
    }

    const schemaContext = {
      description: "A2UI Component Schema — available components for generating UI surfaces. Use these component names and props when creating A2UI operations.",
      value: JSON.stringify(this.config.schema),
    };

    return {
      ...input,
      context: [...(input.context || []), schemaContext],
    };
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
   * For tools with registered streaming surfaces, emits createSurface + updateComponents
   * on TOOL_CALL_START and streams updateDataModel as args are generated.
   */
  private processStream(source: Observable<EventWithState>): Observable<BaseEvent> {
    // Build lookup: toolName → surface config
    const surfacesByTool = new Map<string, A2UISurfaceConfig>();
    for (const entry of this.config.streamingSurfaces ?? []) {
      surfacesByTool.set(entry.toolName, entry.surface);
    }

    const RENDER_A2UI_TOOL = "render_a2ui";

    return new Observable<BaseEvent>((subscriber) => {
      let heldRunFinished: EventWithState | null = null;
      // Tool call IDs belonging to A2UI tools (skip auto-detection in TOOL_CALL_RESULT)
      const a2uiToolCallIds = new Set<string>();

      // Unified streaming tracker: used by both fixed-schema and dynamic render_a2ui.
      // Fixed-schema: schema is set on TOOL_CALL_START from config.
      // Dynamic: schema is extracted from streaming args when updateComponents completes.
      const streamingToolCalls = new Map<string, {
        schema: A2UISurfaceConfig | null; // null until schema is extracted (dynamic case)
        args: string;
        emittedCount: number;
        dataKey: string;         // which key to extract items from
        schemaEmitted: boolean;  // whether schema has been sent to the renderer
        actionHandlers?: Record<string, Array<Record<string, unknown>>>; // dynamic action handlers
      }>();

      // Track send_a2ui_json_to_client for progressive streaming (legacy/direct path)
      const a2uiJsonStreams = new Map<string, {
        args: string;
        emittedCount: number;
      }>();

      const subscription = source.subscribe({
        next: (eventWithState) => {
          const event = eventWithState.event;

          if (event.type === EventType.TOOL_CALL_START) {
            const startEvent = event as ToolCallStartEvent;

            // send_a2ui_json_to_client: track for progressive parsing
            if (startEvent.toolCallName === SEND_A2UI_TOOL_NAME) {
              a2uiToolCallIds.add(startEvent.toolCallId);
              a2uiJsonStreams.set(startEvent.toolCallId, { args: "", emittedCount: 0 });
            }

            // render_a2ui: dynamic streaming is handled via auto-detect on
            // the outer tool's TOOL_CALL_RESULT. Tracking render_a2ui args
            // directly causes duplicate surfaces when it's called as an inner
            // tool inside generate_a2ui. Leave this to the auto-detect path.

            // Fixed-schema streaming surfaces: schema comes from config
            const schema = surfacesByTool.get(startEvent.toolCallName);
            if (schema) {
              streamingToolCalls.set(startEvent.toolCallId, {
                schema, args: "", emittedCount: 0,
                dataKey: schema.dataKey, schemaEmitted: true,
              });

              // Emit schema immediately (v0.9 format)
              const schemaOps = [
                { version: "v0.9", createSurface: { surfaceId: schema.surfaceId, catalogId: schema.catalogId } },
                { version: "v0.9", updateComponents: { surfaceId: schema.surfaceId, components: schema.components } },
              ];
              for (const activityEvent of this.createA2UIActivityEvents(
                schemaOps, schema.actionHandlers, startEvent.toolCallId,
              )) {
                subscriber.next(activityEvent);
              }
            }
          }

          // Stream data updates as tool args come in
          if (event.type === EventType.TOOL_CALL_ARGS) {
            const argsEvent = event as ToolCallArgsEvent;

            // ── Unified streaming handler (fixed-schema + render_a2ui) ──
            const streaming = streamingToolCalls.get(argsEvent.toolCallId);
            if (streaming) {
              streaming.args += argsEvent.delta;

              // Performance: only attempt extraction when the delta contains
              // characters that could complete a JSON structure. Most deltas
              // are mid-string/mid-number and can't change parse results.
              const deltaHasClosingBrace = argsEvent.delta.includes("}");
              const deltaHasClosingBracket = argsEvent.delta.includes("]");
              const deltaHasStructuralChar = deltaHasClosingBrace || deltaHasClosingBracket;

              // For dynamic (render_a2ui): extract schema from the structured args.
              // We wait for the components array to be fully closed before setting
              // the schema, because partial components (e.g., only the root Column
              // without its children) cause the Lit processor to fail validation.
              if (!streaming.schema && deltaHasStructuralChar) {
                const result = extractCompleteItemsWithStatus(streaming.args, "components");
                const surfaceId = extractStringField(streaming.args, "surfaceId");
                const rawCatalogId = extractStringField(streaming.args, "catalogId") ?? "basic";
                const catalogId = rawCatalogId === "basic"
                  ? "https://a2ui.org/specification/v0_9/basic_catalog.json"
                  : rawCatalogId;
                if (result?.arrayClosed && result.items.length > 0 && surfaceId) {
                  streaming.schema = { surfaceId, catalogId, components: result.items as any[], dataKey: "items" };
                  streaming.dataKey = "items";
                }
              }

              // Try to extract actionHandlers from the accumulated args.
              // actionHandlers is a dict, so we attempt to parse the full args JSON
              // and extract it when available. Only attempt JSON.parse when the
              // accumulated string ends with '}', avoiding costly exception creation
              // on every delta (the actionHandlers field comes last in the JSON).
              const hadActionHandlers = !!streaming.actionHandlers;
              if (!streaming.actionHandlers && deltaHasClosingBrace) {
                const trimmed = streaming.args.trimEnd();
                if (trimmed.endsWith("}")) {
                  try {
                    const fullArgs = JSON.parse(streaming.args);
                    if (fullArgs.actionHandlers && typeof fullArgs.actionHandlers === "object" && !Array.isArray(fullArgs.actionHandlers)) {
                      streaming.actionHandlers = fullArgs.actionHandlers;
                    }
                  } catch {
                    // Partial JSON — not yet parseable, will try again on next delta
                  }
                }
              }

              // Stream data items progressively — shared by both fixed-schema and dynamic.
              // For dynamic surfaces where schema was just extracted, we defer the schema
              // emission until we have at least one data item.  This ensures the surface is
              // always created with data, avoiding a race condition where an empty-data
              // ACTIVITY_SNAPSHOT followed by a data ACTIVITY_SNAPSHOT can cause the
              // frontend to lose the data update.
              if (streaming.schema && deltaHasStructuralChar) {
                const items = extractCompleteItems(streaming.args, streaming.dataKey);
                const newItems = items && items.length > streaming.emittedCount;
                // Re-emit if actionHandlers were just extracted (even with no new items)
                const actionHandlersJustExtracted = !hadActionHandlers && !!streaming.actionHandlers && streaming.emittedCount > 0;
                if (newItems || actionHandlersJustExtracted) {
                  const currentItems = items ?? [];
                  // On the first emission for dynamic surfaces, include createSurface
                  const isFirstEmission = !streaming.schemaEmitted;
                  streaming.schemaEmitted = true;
                  if (newItems) streaming.emittedCount = currentItems.length;
                  emitStreamingData(subscriber, streaming.schema, streaming.dataKey, currentItems, argsEvent.toolCallId, streaming.actionHandlers, isFirstEmission);
                }
              }
            }

            // ── send_a2ui_json_to_client: progressive parsing (non-streaming path) ──
            const a2uiStream = a2uiJsonStreams.get(argsEvent.toolCallId);
            if (a2uiStream) {
              a2uiStream.args += argsEvent.delta;
              // Only attempt extraction when the delta contains a closing brace,
              // which could complete an operation object.
              const ops = argsEvent.delta.includes("}")
                ? extractCompleteA2UIOperations(a2uiStream.args)
                : null;
              if (ops && ops.length > a2uiStream.emittedCount) {
                a2uiStream.emittedCount = ops.length;

                // Auto-inject createSurface for updateComponents that don't have one yet (v0.9)
                const opsToEmit = [...ops];
                const surfaceIds = new Set<string>();
                const hasCreateSurface = new Set<string>();
                for (const op of opsToEmit) {
                  const uc = (op as any).updateComponents;
                  if (uc?.surfaceId) surfaceIds.add(uc.surfaceId);
                  const cs = (op as any).createSurface;
                  if (cs?.surfaceId) hasCreateSurface.add(cs.surfaceId);
                }
                for (const sid of surfaceIds) {
                  if (!hasCreateSurface.has(sid)) {
                    opsToEmit.unshift({ version: "v0.9", createSurface: { surfaceId: sid, catalogId: "https://a2ui.org/specification/v0_9/basic_catalog.json" } });
                  }
                }

                for (const activityEvent of this.createA2UIActivityEvents(
                  opsToEmit, undefined, argsEvent.toolCallId,
                )) {
                  subscriber.next(activityEvent);
                }
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
              const isTrackedA2UI = a2uiToolCallIds.has(resultEvent.toolCallId);
              const isStreaming = streamingToolCalls.has(resultEvent.toolCallId);

              // Fallback: if a streaming tool call never emitted its schema (e.g. args
              // didn't parse), fall through to auto-detection on the final result.
              const streamingEntry = streamingToolCalls.get(resultEvent.toolCallId);
              const streamingHandled = isStreaming && streamingEntry?.schemaEmitted;

              // Skip if this is a fully-handled streaming tool call or send_a2ui tool
              if (!isTrackedA2UI && !streamingHandled) {
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

    // Emit a single ACTIVITY_SNAPSHOT per surface with replace: true.
    // Using replace: true ensures all operations (createSurface + updateComponents
    // + updateDataModel) are delivered atomically, preventing intermediate renders
    // with partial operations that can break data binding resolution.
    for (const [surfaceId, surfaceOps] of operationsBySurface) {
      // Include toolCallId in messageId to ensure each tool invocation
      // creates a distinct activity message, even for the same surfaceId
      const messageId = toolCallId
        ? `a2ui-surface-${surfaceId}-${toolCallId}`
        : `a2ui-surface-${surfaceId}`;

      const content: Record<string, unknown> = { [A2UI_OPERATIONS_KEY]: surfaceOps };
      if (actionHandlers) {
        content.actionHandlers = actionHandlers;
      }

      const snapshotEvent: ActivitySnapshotEvent = {
        type: EventType.ACTIVITY_SNAPSHOT,
        messageId,
        activityType: A2UIActivityType,
        content,
        replace: true,
      };
      events.push(snapshotEvent);
    }

    return events;
  }
}

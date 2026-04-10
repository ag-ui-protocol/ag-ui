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
  Tool,
} from "@ag-ui/client";
import { Observable } from "rxjs";

import {
  A2UIMiddlewareConfig,
  A2UIForwardedProps,
  A2UIUserAction,
} from "./types";
import { RENDER_A2UI_TOOL, RENDER_A2UI_TOOL_NAME, RENDER_A2UI_TOOL_GUIDELINES, LOG_A2UI_EVENT_TOOL_NAME } from "./tools";
import { getOperationSurfaceId, tryParseA2UIOperations, A2UI_OPERATIONS_KEY, extractCompleteItemsWithStatus, extractCompleteObject, extractStringField } from "./schema";

// Re-exports
export * from "./types";
export * from "./tools";
export * from "./schema";

/**
 * Activity type for A2UI surface events
 */
export const A2UIActivityType = "a2ui-surface";

/**
 * Context description used to identify the A2UI component schema in RunAgentInput.context.
 * The LangGraph connector uses this to extract the schema from context and inject it
 * into the agent's key/value state instead of the system prompt.
 */
export const A2UI_SCHEMA_CONTEXT_DESCRIPTION = "A2UI Component Schema — available components for generating UI surfaces. Use these component names and props when creating A2UI operations.";

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

    // Conditionally inject the render_a2ui tool and its usage guidelines
    const finalInput = this.config.injectA2UITool
      ? this.injectToolGuidelines(this.injectTool(withSchema))
      : withSchema;

    // Process the event stream using runNextWithState for automatic message tracking
    return this.processStream(this.runNextWithState(finalInput, next));
  }

  /**
   * Inject the A2UI component schema into RunAgentInput.context.
   * This makes the schema available to agents as a context entry,
   * similar to how useAgentContext propagates application context.
   *
   * If the frontend already provided a schema context entry (via includeSchema),
   * the server-side schema replaces it.
   */
  private injectSchemaContext(input: RunAgentInput): RunAgentInput {
    if (!this.config.schema || this.config.schema.length === 0) {
      return input;
    }

    const schemaContext = {
      description: A2UI_SCHEMA_CONTEXT_DESCRIPTION,
      value: JSON.stringify(this.config.schema),
    };

    // Replace any existing entry with the same description (e.g. from the frontend)
    const filtered = (input.context || []).filter(
      (c) => c.description !== A2UI_SCHEMA_CONTEXT_DESCRIPTION,
    );

    return {
      ...input,
      context: [...filtered, schemaContext],
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
   * Inject the A2UI rendering tool into the input.
   * Uses the configured name from `injectA2UITool` (string) or defaults to "render_a2ui".
   * Always replaces the tool if it already exists to ensure the correct parameter schema.
   */
  private injectTool(input: RunAgentInput): RunAgentInput {
    const toolName = typeof this.config.injectA2UITool === "string"
      ? this.config.injectA2UITool
      : RENDER_A2UI_TOOL_NAME;
    const tool: Tool = { ...RENDER_A2UI_TOOL, name: toolName };
    const filteredTools = input.tools.filter((t) => t.name !== toolName);
    return {
      ...input,
      tools: [...filteredTools, tool],
    };
  }

  /**
   * Inject usage guidelines for the render_a2ui tool as a context entry.
   * Provides the LLM with protocol instructions and a minimal example so it
   * can produce valid A2UI without agent-specific prompting.
   */
  private injectToolGuidelines(input: RunAgentInput): RunAgentInput {
    const toolName = typeof this.config.injectA2UITool === "string"
      ? this.config.injectA2UITool
      : RENDER_A2UI_TOOL_NAME;

    const guidelinesDescription =
      `A2UI render tool usage guide — how to call ${toolName} with valid arguments.`;

    // Remove any existing guidelines entry to avoid duplication
    const filtered = (input.context || []).filter(
      (c) => c.description !== guidelinesDescription,
    );

    return {
      ...input,
      context: [...filtered, {
        description: guidelinesDescription,
        value: RENDER_A2UI_TOOL_GUIDELINES(toolName),
      }],
    };
  }

  /**
   * Process the event stream, holding back RUN_FINISHED to process pending A2UI tool calls.
   * Uses runNextWithState for automatic message tracking.
   */
  private processStream(source: Observable<EventWithState>): Observable<BaseEvent> {
    // Tool names recognized as A2UI rendering tools
    const a2uiToolNames = new Set(this.config.a2uiToolNames ?? [RENDER_A2UI_TOOL_NAME]);

    return new Observable<BaseEvent>((subscriber) => {
      let heldRunFinished: EventWithState | null = null;

      // Streaming tracker for dynamic render_a2ui tool calls.
      // Schema is extracted from streaming args when updateComponents completes.
      const streamingToolCalls = new Map<string, {
        schema: { surfaceId: string; catalogId: string; components: Array<Record<string, unknown>> } | null;
        args: string;
        emittedCount: number;
        schemaEmitted: boolean;  // whether schema has been sent to the renderer
        dataEmitted: boolean;    // whether data model has been sent
      }>();

      const subscription = source.subscribe({
        next: (eventWithState) => {
          const event = eventWithState.event;

          if (event.type === EventType.TOOL_CALL_START) {
            const startEvent = event as ToolCallStartEvent;

            // render_a2ui: dynamic streaming. Track streaming args to
            // extract schema (components) first, then data.
            // If streaming extraction fails, auto-detect on the outer
            // tool's TOOL_CALL_RESULT still works as a fallback.
            if (a2uiToolNames.has(startEvent.toolCallName)) {
              streamingToolCalls.set(startEvent.toolCallId, {
                schema: null, args: "", emittedCount: 0,
                schemaEmitted: false, dataEmitted: false,
              });
            }
          }

          // Stream data updates as tool args come in
          if (event.type === EventType.TOOL_CALL_ARGS) {
            const argsEvent = event as ToolCallArgsEvent;

            // ── Streaming handler for render_a2ui ──
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
              if (deltaHasStructuralChar) {
                const result = extractCompleteItemsWithStatus(streaming.args, "components");
                const surfaceId = extractStringField(streaming.args, "surfaceId");
                const rawCatalogId = extractStringField(streaming.args, "catalogId") ?? "basic";
                const catalogId = rawCatalogId === "basic"
                  ? "https://a2ui.org/specification/v0_9/basic_catalog.json"
                  : rawCatalogId;

                if (result && result.items.length > 0 && surfaceId) {
                  // Progressive component streaming: emit activity snapshots
                  // as components arrive, not just when the full array closes.
                  const newComponents = result.items.length > streaming.emittedCount;

                  if (newComponents) {
                    if (!streaming.schema) {
                      // First emission — create the schema object
                      streaming.schema = { surfaceId, catalogId, components: result.items as any[] };
                    } else {
                      // Update components in existing schema
                      streaming.schema.components = result.items as any[];
                    }

                    streaming.schemaEmitted = true;
                    streaming.emittedCount = result.items.length;

                    // Always include createSurface in every replace:true snapshot.
                    // If React batches renders and only processes a later snapshot,
                    // the surface must still be created. The frontend filters out
                    // duplicate createSurface when the surface already exists.
                    const ops: Array<Record<string, unknown>> = [];
                    ops.push({ version: "v0.9", createSurface: { surfaceId, catalogId } });
                    ops.push({ version: "v0.9", updateComponents: { surfaceId, components: result.items } });

                    // Try to include data model if "data" object is available
                    const data = extractCompleteObject(streaming.args, "data");
                    if (data) {
                      streaming.dataEmitted = true;
                      ops.push({ version: "v0.9", updateDataModel: { surfaceId, path: "/", value: data } });
                    }

                    const content: Record<string, unknown> = { [A2UI_OPERATIONS_KEY]: ops };
                    const snapshotEvent: ActivitySnapshotEvent = {
                      type: EventType.ACTIVITY_SNAPSHOT,
                      messageId: `a2ui-surface-${surfaceId}-${argsEvent.toolCallId}`,
                      activityType: A2UIActivityType,
                      content,
                      replace: true,
                    };
                    subscriber.next(snapshotEvent);
                  }
                }
              }

              // Handle late-arriving data: if components were already emitted but
              // data wasn't ready yet (streams after components), emit a new snapshot
              // with the data once it becomes extractable.
              if (deltaHasStructuralChar && streaming.schemaEmitted && !streaming.dataEmitted && streaming.schema) {
                const data = extractCompleteObject(streaming.args, "data");
                if (data) {
                  streaming.dataEmitted = true;
                  const { surfaceId, catalogId } = streaming.schema;
                  const ops: Array<Record<string, unknown>> = [
                    { version: "v0.9", createSurface: { surfaceId, catalogId } },
                    { version: "v0.9", updateComponents: { surfaceId, components: streaming.schema.components } },
                    { version: "v0.9", updateDataModel: { surfaceId, path: "/", value: data } },
                  ];
                  const content: Record<string, unknown> = { [A2UI_OPERATIONS_KEY]: ops };
                  const snapshotEvent: ActivitySnapshotEvent = {
                    type: EventType.ACTIVITY_SNAPSHOT,
                    messageId: `a2ui-surface-${surfaceId}-${argsEvent.toolCallId}`,
                    activityType: A2UIActivityType,
                    content,
                    replace: true,
                  };
                  subscriber.next(snapshotEvent);
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
              const isStreaming = streamingToolCalls.has(resultEvent.toolCallId);

              // Fallback: if a streaming tool call never emitted its schema (e.g. args
              // didn't parse), fall through to auto-detection on the final result.
              const streamingEntry = streamingToolCalls.get(resultEvent.toolCallId);
              const streamingHandled = isStreaming && streamingEntry?.schemaEmitted;

              // Also check if ANY streaming entry already handled a surface.
              // This covers the case where render_a2ui (inner tool) streamed the
              // surface, but the TOOL_CALL_RESULT belongs to generate_a2ui (outer
              // tool) — different toolCallId, but same surface already rendered.
              let anyStreamingHandled = streamingHandled;
              if (!anyStreamingHandled) {
                for (const entry of streamingToolCalls.values()) {
                  if (entry.schemaEmitted) {
                    anyStreamingHandled = true;
                    break;
                  }
                }
              }

              // Skip if any streaming entry already rendered a surface (e.g.,
              // render_a2ui streamed the surface, and now generate_a2ui's result
              // would duplicate it).
              if (!anyStreamingHandled) {
                const parsed = tryParseA2UIOperations(resultEvent.content);
                if (parsed) {
                  // Emit all operations at once. Unlike the streaming path
                  // (render_a2ui), explicit a2ui_operations arrive complete —
                  // splitting schema and data would cause the renderer to
                  // crash on unresolved path bindings before data exists.
                  for (const activityEvent of this.createA2UIActivityEvents(
                    parsed.operations,
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
            // Emit synthetic TOOL_CALL_RESULT for pending render_a2ui calls.
            // The streaming handler already emitted activity events during
            // TOOL_CALL_ARGS, so we just need to close the tool call.
            const pendingToolCalls = this.findPendingToolCalls(heldRunFinished.messages);
            const pendingRenderCalls = pendingToolCalls.filter(
              (tc) => a2uiToolNames.has(tc.function.name)
            );
            for (const toolCall of pendingRenderCalls) {
              const resultEvent: ToolCallResultEvent = {
                type: EventType.TOOL_CALL_RESULT,
                messageId: randomUUID(),
                toolCallId: toolCall.id,
                content: JSON.stringify({ status: "rendered" }),
              };
              subscriber.next(resultEvent);
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
   * Create ACTIVITY_SNAPSHOT events from A2UI operations, grouped by surfaceId.
   *
   * @param operations - A2UI operations to emit
   * @param toolCallId - Unique tool call ID to isolate surfaces between invocations
   */
  private createA2UIActivityEvents(
    operations: Array<Record<string, unknown>>,
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

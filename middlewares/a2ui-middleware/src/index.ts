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
import { getOperationSurfaceId, tryParseA2UIOperations, A2UI_OPERATIONS_KEY, extractCompleteItemsWithStatus, extractCompleteObject, extractDataArrayItems, extractStringField } from "./schema";

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
export const A2UI_SCHEMA_CONTEXT_DESCRIPTION = "A2UI Component Schema — available components for generating UI surfaces. Use these component names and properties when creating A2UI operations.";

/**
 * Extract EventWithState type from Middleware.runNextWithState return type
 */
type ExtractObservableType<T> = T extends Observable<infer U> ? U : never;
type RunNextWithStateReturn = ReturnType<Middleware["runNextWithState"]>;
type EventWithState = ExtractObservableType<RunNextWithStateReturn>;

/**
 * Derive the repeated-data array key from a component set.
 *
 * A2UI "list" surfaces repeat one template component over an array in the data
 * model via structural children: `children: { componentId, path: "/items" }`.
 * The data key is that path with its leading slash stripped (e.g. "items").
 *
 * Returns the first such key found, or null when no structural repeat exists
 * (e.g. a form or static composition), in which case the caller falls back to
 * a sensible default and/or the final whole-object data emit.
 */
function deriveRepeatedDataKey(components: Array<Record<string, unknown>>): string | null {
  for (const comp of components) {
    const children = (comp as any)?.children;
    if (
      children &&
      typeof children === "object" &&
      !Array.isArray(children) &&
      typeof children.path === "string" &&
      children.path.length > 0
    ) {
      return children.path.replace(/^\//, "");
    }
  }
  return null;
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
      ? this.injectToolGuidelines(this.injectToolAndFlag(withSchema))
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
    if (!this.config.schema) {
      return input;
    }
    // Empty check: array → length, inline catalog → no components
    const isEmpty = Array.isArray(this.config.schema)
      ? this.config.schema.length === 0
      : Object.keys(this.config.schema.components ?? {}).length === 0;
    if (isEmpty) {
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
   * Inject the A2UI rendering tool + the "injectA2UITool" flag into the input.
   * Uses the configured name from `injectA2UITool` (string) or defaults to "render_a2ui".
   * Always replaces the tool if it already exists to ensure the correct parameter schema.
   */
  private injectToolAndFlag(input: RunAgentInput): RunAgentInput {
    const toolName = typeof this.config.injectA2UITool === "string"
      ? this.config.injectA2UITool
      : RENDER_A2UI_TOOL_NAME;
    const tool: Tool = { ...RENDER_A2UI_TOOL, name: toolName };
    // Guard against undefined ``input.tools`` — the AG-UI shape allows it.
    const filteredTools = (input.tools ?? []).filter((t) => t.name !== toolName);
    return {
      ...input,
      forwardedProps: {
        ...input.forwardedProps,
        injectA2UITool: this.config.injectA2UITool,
      },
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
    // Tool names recognized as A2UI rendering tools. When the middleware also
    // INJECTS the rendering tool (config.injectA2UITool truthy), the injected
    // name MUST be part of the intercept set — otherwise TOOL_CALL_START for
    // it wouldn't open a streaming entry and the progressive-render path
    // would silently degrade to result-only.
    //
    // Two cases to cover:
    //   - `injectA2UITool: true`       → injected under the default
    //     RENDER_A2UI_TOOL_NAME (matches the default `a2uiToolNames`, but a
    //     host that ALSO overrides `a2uiToolNames` to something like
    //     `["foo"]` would lose the default — explicitly re-add).
    //   - `injectA2UITool: "myName"`   → injected under that custom name.
    const a2uiToolNames = new Set(this.config.a2uiToolNames ?? [RENDER_A2UI_TOOL_NAME]);
    if (this.config.injectA2UITool) {
      const injectedName =
        typeof this.config.injectA2UITool === "string" && this.config.injectA2UITool.length > 0
          ? this.config.injectA2UITool
          : RENDER_A2UI_TOOL_NAME;
      a2uiToolNames.add(injectedName);
    }

    return new Observable<BaseEvent>((subscriber) => {
      let heldRunFinished: EventWithState | null = null;

      // Streaming tracker for dynamic render_a2ui tool calls.
      //
      // Progressive emission strategy ("components atomic, data incremental"):
      //  1. createSurface rides into the FIRST snapshot together with components
      //     (never on its own — an empty surface makes the renderer try to
      //     resolve a not-yet-present root component and throw).
      //  2. updateComponents is computed ONCE, only after the components array
      //     is fully closed and every component carries a `component` type. It
      //     IS re-included in every subsequent cumulative snapshot for
      //     idempotency (the host filters duplicates by component id), but the
      //     components payload is the same byte-for-byte across snapshots.
      //  3. updateDataModel is emitted INCREMENTALLY: as each item in the
      //     repeated data array (e.g. `data.items`) closes, a new snapshot
      //     carries the items-so-far. Because the repeated card reuses one
      //     already-emitted template component, growing the data array adds no
      //     new component references — so cards paint one-by-one with no throw.
      //
      // Each emitted snapshot is cumulative (createSurface + updateComponents +
      // updateDataModel-so-far) with replace:true, so any single snapshot is
      // self-sufficient even if the frontend coalesces renders.
      const streamingToolCalls = new Map<string, {
        schema: { surfaceId: string; catalogId: string; components: Array<Record<string, unknown>> } | null;
        args: string;
        outerCallId: string | null; // the outer tool call this streaming inner was started inside (null if direct)
        componentsEmitted: boolean; // updateComponents sent (atomic)
        dataItemsKey: string;      // repeated-array key derived from components
        dataItemsCount: number;    // number of data items emitted so far
        dataComplete: boolean;     // full (closed) data model emitted
      }>();

      // Outer tool call context. Any non-A2UI tool call (e.g. ``generate_a2ui``
      // wrapping a subagent that emits ``render_a2ui`` calls) is treated as
      // the "outer" call. The outer id becomes the activity messageId
      // discriminator so multiple inner ``render_a2ui`` attempts within the
      // same outer call (e.g. validate-then-retry) supersede each other on
      // the frontend instead of stacking as distinct chat entries.
      //
      // When no outer call is active (the agent calls ``render_a2ui``
      // directly), behaviour falls back to the inner tool_call_id, matching
      // the pre-existing scheme.
      const nonOuterToolNames = new Set<string>([
        ...a2uiToolNames,
        LOG_A2UI_EVENT_TOOL_NAME,
      ]);
      let currentOuterCallId: string | null = null;

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
                schema: null, args: "",
                outerCallId: currentOuterCallId,
                componentsEmitted: false,
                dataItemsKey: "items", dataItemsCount: 0, dataComplete: false,
              });
            } else if (!nonOuterToolNames.has(startEvent.toolCallName)) {
              // Any other tool call becomes the active outer-call context.
              // ``render_a2ui`` events that follow will dedup against this id.
              currentOuterCallId = startEvent.toolCallId;
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
              // surfaceId completes as a string value (closing quote), not a
              // brace/bracket — so also probe when the delta closes a string.
              const deltaHasQuote = argsEvent.delta.includes('"');

              if (deltaHasStructuralChar || deltaHasQuote) {
                const surfaceId = extractStringField(streaming.args, "surfaceId");

                // Nothing actionable until we know which surface we're building.
                if (surfaceId) {
                  // Catalog ownership: the host/factory decides the catalog, not
                  // the subagent. Prefer the configured defaultCatalogId; only
                  // fall back to a streamed catalogId (legacy) or the basic
                  // catalog when no catalog was configured. This keeps the
                  // streamed createSurface from referencing a catalog the
                  // frontend never registered (e.g. "basic" when the app uses a
                  // custom catalog) — which throws "Catalog not found".
                  //
                  // Treat an empty-string defaultCatalogId as unset: a `??`
                  // alone would propagate "" into the emitted createSurface and
                  // surface as "Catalog not found: " in the renderer, hiding
                  // the real cause (misconfiguration).
                  const configCatalogId =
                    this.config.defaultCatalogId && this.config.defaultCatalogId.length > 0
                      ? this.config.defaultCatalogId
                      : undefined;
                  const streamedCatalogId = extractStringField(streaming.args, "catalogId");
                  const catalogId =
                    configCatalogId ??
                    (streamedCatalogId && streamedCatalogId !== "basic"
                      ? streamedCatalogId
                      : "https://a2ui.org/specification/v0_9/basic_catalog.json");

                  // (2) Components — emit ONCE, only when the array is fully
                  // closed and every component has a `component` type. Partial
                  // or type-less components would throw in @a2ui/web_core.
                  if (!streaming.componentsEmitted) {
                    const result = extractCompleteItemsWithStatus(streaming.args, "components");
                    if (
                      result &&
                      result.arrayClosed &&
                      result.items.length > 0 &&
                      result.items.every(
                        (c) => c && typeof c === "object" && typeof (c as any).component === "string",
                      )
                    ) {
                      const components = result.items as Array<Record<string, unknown>>;
                      streaming.schema = { surfaceId, catalogId, components };
                      streaming.dataItemsKey = deriveRepeatedDataKey(components) ?? "items";
                    }
                  }

                  // (3) Data — incrementally surface complete items from the
                  // repeated data array (e.g. data.items) once components exist.
                  let dataItems: unknown[] | null = null;
                  let dataItemsAdvanced = false;
                  if (streaming.schema && !streaming.dataComplete) {
                    const itemsResult = extractDataArrayItems(streaming.args, streaming.dataItemsKey);
                    if (itemsResult && itemsResult.items.length > streaming.dataItemsCount) {
                      dataItems = itemsResult.items;
                      dataItemsAdvanced = true;
                    }
                  }

                  // Decide whether this delta advanced any emittable state.
                  //
                  // We deliberately do NOT emit createSurface on its own: an
                  // empty surface makes the renderer try to resolve the root
                  // component immediately, which throws "Component not found:
                  // root" until updateComponents arrives (a visible error
                  // flash). So the first snapshot always carries components.
                  // The loading skeleton during this window is provided by the
                  // render_a2ui tool-call progress indicator, not an empty surface.
                  const componentsAdvanced = !!streaming.schema && !streaming.componentsEmitted;

                  if (componentsAdvanced || dataItemsAdvanced) {
                    const ops: Array<Record<string, unknown>> = [];
                    // Always include createSurface — the frontend filters it out
                    // if the surface already exists, so snapshots stay self-sufficient.
                    ops.push({ version: "v0.9", createSurface: { surfaceId, catalogId } });

                    if (streaming.schema) {
                      ops.push({ version: "v0.9", updateComponents: { surfaceId, components: streaming.schema.components } });
                      streaming.componentsEmitted = true;
                    }

                    if (dataItems && dataItems.length > 0) {
                      streaming.dataItemsCount = dataItems.length;
                      ops.push({
                        version: "v0.9",
                        updateDataModel: { surfaceId, path: "/", value: { [streaming.dataItemsKey]: dataItems } },
                      });
                    }

                    const content: Record<string, unknown> = { [A2UI_OPERATIONS_KEY]: ops };
                    const snapshotEvent: ActivitySnapshotEvent = {
                      type: EventType.ACTIVITY_SNAPSHOT,
                      messageId: `a2ui-surface-${surfaceId}-${streaming.outerCallId ?? argsEvent.toolCallId}`,
                      activityType: A2UIActivityType,
                      content,
                      replace: true,
                    };
                    subscriber.next(snapshotEvent);
                  }

                  // Final authoritative data emit once the whole data object
                  // closes. Covers non-array data keys (e.g. form objects) and
                  // guarantees the data model exactly matches the model's intent.
                  if (streaming.componentsEmitted && !streaming.dataComplete && deltaHasStructuralChar) {
                    const data = extractCompleteObject(streaming.args, "data");
                    if (data) {
                      streaming.dataComplete = true;
                      const ops: Array<Record<string, unknown>> = [
                        { version: "v0.9", createSurface: { surfaceId, catalogId } },
                        { version: "v0.9", updateComponents: { surfaceId, components: streaming.schema!.components } },
                        { version: "v0.9", updateDataModel: { surfaceId, path: "/", value: data } },
                      ];
                      const content: Record<string, unknown> = { [A2UI_OPERATIONS_KEY]: ops };
                      const snapshotEvent: ActivitySnapshotEvent = {
                        type: EventType.ACTIVITY_SNAPSHOT,
                        messageId: `a2ui-surface-${surfaceId}-${streaming.outerCallId ?? argsEvent.toolCallId}`,
                        activityType: A2UIActivityType,
                        content,
                        replace: true,
                      };
                      subscriber.next(snapshotEvent);
                    }
                  }
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

              // Fallback: if a streaming tool call never emitted its components
              // (e.g. args didn't parse), fall through to auto-detection on the
              // final result.
              const streamingEntry = streamingToolCalls.get(resultEvent.toolCallId);
              const streamingHandled = isStreaming && streamingEntry?.componentsEmitted;

              // Also dedup against the SPECIFIC outer call this result belongs
              // to: if an inner ``render_a2ui`` started inside the same outer
              // call already streamed its surface, the outer's result (which
              // typically wraps the same envelope) would re-emit the same
              // surface. Earlier we used a blanket "any streaming entry handled"
              // check, but that wrongly suppressed legitimate later
              // ``a2ui_operations`` payloads from unrelated tools in the same
              // run. Scope the dedup to entries whose outerCallId matches the
              // result's tool-call id.
              let outerHasStreamedSurface = !!streamingHandled;
              if (!outerHasStreamedSurface) {
                for (const entry of streamingToolCalls.values()) {
                  if (entry.componentsEmitted && entry.outerCallId === resultEvent.toolCallId) {
                    outerHasStreamedSurface = true;
                    break;
                  }
                }
              }

              if (!outerHasStreamedSurface) {
                const parsed = tryParseA2UIOperations(resultEvent.content);
                if (parsed) {
                  // Emit all operations at once. Unlike the streaming path
                  // (render_a2ui), explicit a2ui_operations arrive complete —
                  // splitting schema and data would cause the renderer to
                  // crash on unresolved path bindings before data exists.
                  for (const activityEvent of this.createA2UIActivityEvents(
                    parsed.operations,
                    currentOuterCallId ?? resultEvent.toolCallId,
                  )) {
                    subscriber.next(activityEvent);
                  }
                }
              }

              // Clear outer-call context when its TOOL_CALL_RESULT arrives.
              if (currentOuterCallId === resultEvent.toolCallId) {
                currentOuterCallId = null;
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

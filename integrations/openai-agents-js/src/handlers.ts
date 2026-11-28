/**
 * Stream-event → AG-UI event translation for the OpenAI Agents JS adapter.
 *
 * Each handler is a pure function over an SDK stream event plus a `StreamContext`,
 * returning an array of AG-UI `BaseEvent`s to emit. Keeping this layer pure and
 * side-effect-free makes the mapping trivially unit-testable without the SDK.
 */

import { EventType } from "@ag-ui/core";
import type {
  BaseEvent,
  Interrupt,
  Message,
} from "@ag-ui/core";

import { STATE_MANAGEMENT_TOOL_NAME } from "./config";
import { outputToString } from "./utils";

/** An AG-UI tool-call entry attached to an assistant message (OpenAI shape). */
interface AssistantToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** In-flight assistant message being accumulated for MESSAGES_SNAPSHOT. */
interface PendingAssistant {
  id: string;
  content: string;
  toolCalls: AssistantToolCall[];
}

/**
 * Per-run mutable state shared across handlers. Tracks which message / tool
 * call / reasoning block is currently open so deltas attach to the right IDs,
 * and accumulates the state + messages produced during the run.
 */
export class StreamContext {
  /** AG-UI message id for the currently-streaming assistant text message, if any. */
  currentMessageId?: string;
  /** True once a TEXT_MESSAGE_START has been emitted for the current message. */
  messageOpen = false;
  textMessageClosed = false;

  /** AG-UI message id for the currently-streaming reasoning block, if any. */
  currentReasoningId?: string;
  /** True once a REASONING_MESSAGE_START has been emitted for the current block. */
  reasoningOpen = false;

  /** Backend calls awaiting a tool output. */
  openToolCalls = new Set<string>();

  /** toolCallId → accumulated argument-string deltas (so we can emit on done). */
  readonly toolCallArgs = new Map<string, string>();
  readonly pendingToolCallEnds = new Set<string>();
  readonly endedToolCalls = new Set<string>();
  readonly completedToolCallArgs = new Set<string>();
  readonly toolCallItemIds = new Map<string, string>();
  private readonly assistantToolCalls = new Map<string, AssistantToolCall>();
  private messageSequence = 0;
  private readonly usedMessageIds: Set<string>;

  /** toolCallId → tool name, captured when the call item is first seen. */
  readonly toolCallNames = new Map<string, string>();

  /** toolCallIds produced by the state-management tool (intercepted, not forwarded). */
  readonly stateToolCallIds = new Set<string>();

  /**
   * Names of AG-UI frontend tools (from `input.tools`). A `tool_called` whose
   * name is in this set is a frontend tool: the adapter emits `TOOL_CALL_*`,
   * halts the run (sets `halt`), and lets the frontend execute it. Set by the
   * adapter before consuming the stream. (Phase 5.)
   */
  frontendToolNames: Set<string> = new Set();
  interruptFrontendTools = true;

  /** Set to `true` when the run must stop consuming the SDK stream — i.e. a
   *  frontend tool was called and the frontend must execute it. (Phase 5.) */
  halt = false;

  /**
   * Interrupts raised this run (one per frontend-tool halt), surfaced as the
   * `RUN_FINISHED` `outcome: { type: "interrupt", interrupts }`. (Phase 5.)
   */
  readonly interrupts: Interrupt[] = [];

  /** Shared application state, seeded from `input.state` and evolved as the
   *  model calls `ag_ui_update_state` (replace semantics). */
  currentState: unknown;

  /** Messages produced during this run, merged into the MESSAGES_SNAPSHOT. */
  readonly messages: Message[] = [];

  /** Assistant message being accumulated (text + tool calls), flushed on close. */
  private pendingAssistant: PendingAssistant | null = null;

  constructor(
    /** Base id used to derive message ids when the SDK provides none. */
    public readonly runId: string,
    initialState?: unknown,
    existingMessageIds: Iterable<string> = [],
  ) {
    this.currentState = initialState ?? null;
    this.usedMessageIds = new Set(existingMessageIds);
  }

  /** Record a frontend-tool interrupt and arm the halt flag. (Phase 5.) */
  addInterrupt(toolCallId: string, toolName: string): void {
    this.interrupts.push({
      id: toolCallId,
      reason: "frontend_tool",
      toolCallId,
      metadata: { toolName },
    });
    this.halt = true;
  }

  /**
   * Ensure an in-flight assistant message exists (lazily created with the
   * current message id) and return it so handlers can append content / calls.
   */
  private ensurePendingAssistant(): PendingAssistant {
    if (!this.pendingAssistant) {
      this.currentMessageId ??= this.nextMessageId();
      this.pendingAssistant = {
        id: this.currentMessageId,
        content: "",
        toolCalls: [],
      };
    }
    return this.pendingAssistant;
  }

  nextMessageId(): string {
    while (true) {
      const sequence = this.messageSequence++;
      const messageId = sequence === 0 ? this.runId : `${this.runId}-${sequence}`;
      if (this.usedMessageIds.has(messageId)) continue;
      this.usedMessageIds.add(messageId);
      return messageId;
    }
  }

  /** Append streamed assistant text to the pending message. */
  appendAssistantText(delta: string): void {
    this.ensurePendingAssistant().content += delta;
  }

  /** Attach a (non-state) tool call to the pending assistant message. */
  recordAssistantToolCall(
    callId: string,
    name: string,
    args: string,
  ): void {
    const call: AssistantToolCall = {
      id: callId,
      type: "function",
      function: { name, arguments: args },
    };
    this.ensurePendingAssistant().toolCalls.push(call);
    this.assistantToolCalls.set(callId, call);
  }

  updateAssistantToolCallArgs(callId: string, args: string): void {
    const call = this.assistantToolCalls.get(callId);
    if (call) call.function.arguments = args;
  }

  /**
   * Flush the pending assistant message (if it has content or tool calls) into
   * `messages`. Called at end-of-stream and before a tool result.
   */
  flushPendingAssistant(rotateId = true): void {
    const p = this.pendingAssistant;
    if (p && (p.content || p.toolCalls.length > 0)) {
      this.upsertMessage({
        id: p.id,
        role: "assistant",
        ...(p.content ? { content: p.content } : {}),
        ...(p.toolCalls.length > 0 ? { toolCalls: p.toolCalls } : {}),
      } as Message);
    }
    this.pendingAssistant = null;
    if (rotateId) {
      this.currentMessageId = undefined;
      this.textMessageClosed = false;
    }
  }

  /** Insert-or-replace a message in `messages` by id. */
  upsertMessage(msg: Message): void {
    const idx = this.messages.findIndex((m) => m.id === msg.id);
    if (idx !== -1 && this.messages[idx].role === "assistant" && msg.role === "assistant") {
      const previous = this.messages[idx];
      const calls = [...(previous.toolCalls ?? [])];
      for (const call of msg.toolCalls ?? []) {
        const callIndex = calls.findIndex((existing) => existing.id === call.id);
        if (callIndex === -1) calls.push(call);
        else calls[callIndex] = call;
      }
      this.messages[idx] = {
        ...previous,
        ...msg,
        ...(calls.length ? { toolCalls: calls } : {}),
      };
    } else if (idx !== -1) this.messages[idx] = msg;
    else this.messages.push(msg);
  }
}

/* ----------------------------- raw model events ---------------------------- */

/**
 * The shape of the raw model stream as exposed by `@openai/agents` v0.12.
 *
 * `RunRawModelStreamEvent.data` is a `ResponseStreamEvent` (see
 * `@openai/agents-core` `dist/types/helpers.d.ts`), which is the union
 * `StreamEvent` defined in `dist/types/protocol.d.ts`:
 *
 *   type StreamEvent =
 *     | { type: "output_text_delta"; delta: string }      // typed directly
 *     | { type: "response_done";     response: ... }       // typed directly
 *     | { type: "response_started" }                      // typed directly
 *     | { type: "model"; event: <raw Responses-API event> }; // passthrough
 *
 * Crucially, only `output_text_delta` is typed with a `delta` field. Every
 * other raw delta the Responses API emits — tool-call argument deltas,
 * reasoning-summary deltas, refusal deltas, etc. — arrives inside the
 * generic `{ type: "model", event }` passthrough as a raw
 * Responses-API event from the `openai` package (e.g.
 * `response.function_call_arguments.delta`,
 * `response.reasoning_summary_text.delta`).
 *
 * ⚠️ UPGRADE IMPACT: this is the part most likely to break on a
 * `@openai/agents` (or `openai`) bump:
 *   1. The `StreamEvent` union members may grow (e.g. a future SDK could type
 *      `tool_call_argument_delta` directly instead of routing it through the
 *      `model` passthrough). If so, the `data.type === "output_text_delta"`
 *      branch below would gain siblings and the `data.type === "model"`
 *      fallback would simply stop receiving those events.
 *   2. The raw `event.type` string literals come from the `openai` package's
 *      `ResponseStreamEvent` union (`openai/resources/responses/responses.d.ts`).
 *      They are a public API but have changed between major `openai` releases.
 *      NOTE: `@openai/agents` v0.12 bundles `openai@6.x` internally, while this
 *      package's own `import "openai"` may resolve to a different major (it
 *      declares `openai` as an optional peer/dev dep). The literals that
 *      actually flow through the passthrough at runtime are those of the
 *      `openai` version `@openai/agents` bundles — not necessarily the one this
 *      package resolves to — so treat these strings as a runtime contract, not
 *      something type-checkable from this package's `openai` types.
 *   3. The field names on the raw events (`item_id`, `delta`, `output_index`)
 *      are owned by the `openai` package, not `@openai/agents`.
 *
 * To catch drift early, `src/sdk-shapes.test.ts` pins these shapes two ways:
 *   - COMPILE-TIME guards fail the build if the SDK renames a class `type`
 *     discriminant, a run-item event name, the directly-typed
 *     `output_text_delta` shape, or the `model` passthrough wrapper.
 *   - RUNTIME contract tests pin the exact raw passthrough literals + fields
 *     (`item_id`, `delta`) as fixtures and assert this function maps each to
 *     the expected AG-UI event. If an `openai` major bump renames a literal or
 *     field, the fixture stops matching and the test fails — forcing a
 *     conscious update of both the test and this switch together.
 */
export function handleRawModelStreamEvent(
  data: any,
  ctx: StreamContext,
): BaseEvent[] {
  const events: BaseEvent[] = [];
  if (!data || typeof data !== "object") return events;

  // Direct text deltas — the only non-passthrough stream shape the SDK types
  // (see the StreamEvent union in @openai/agents-core protocol.d.ts).
  if (data.type === "output_text_delta" && typeof data.delta === "string") {
    if (!ctx.messageOpen) {
      if (ctx.textMessageClosed) ctx.flushPendingAssistant();
      ctx.currentMessageId = ctx.currentMessageId ?? ctx.nextMessageId();
      ctx.messageOpen = true;
      events.push({
        type: EventType.TEXT_MESSAGE_START,
        messageId: ctx.currentMessageId,
        role: "assistant",
      });
    }
    events.push({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: ctx.currentMessageId!,
      delta: data.delta,
    });
    ctx.appendAssistantText(data.delta);
    return events;
  }

  // Passthrough "model" events wrap raw Responses-API events in `event`.
  // The wrapper shape `{ type: "model", event: <ResponseStreamEvent> }` is
  // `StreamEventGenericItem` in @openai/agents-core; the inner `event` is a
  // raw event from the `openai` package (see the doc comment above for why
  // this is upgrade-sensitive).
  const raw = data.type === "model" ? data.event : data;
  if (!raw || typeof raw !== "object") return events;

  // The `raw.type` literals below are the string discriminants of the
  // `openai` package's `ResponseStreamEvent` union. If a future `openai`
  // release renames them, the matching cases here go silent (deltas stop
  // mapping) — `sdk-shapes.test.ts` pins these literals to catch that.
  switch (raw.type) {
    case "response.output_item.added":
    case "response.output_item.done": {
      const item = raw.item;
      if (item?.type !== "function_call" || typeof item.id !== "string" ||
          typeof item.call_id !== "string") break;
      ctx.toolCallItemIds.set(item.id, item.call_id);
      if (item.id !== item.call_id) {
        if (ctx.toolCallArgs.has(item.id)) {
          ctx.toolCallArgs.set(item.call_id, ctx.toolCallArgs.get(item.id)!);
          ctx.toolCallArgs.delete(item.id);
        }
        if (ctx.completedToolCallArgs.delete(item.id)) {
          ctx.completedToolCallArgs.add(item.call_id);
        }
      }
      break;
    }
    case "response.function_call_arguments.delta": {
      // Shape: { type, item_id, delta, output_index, sequence_number }
      if (typeof raw.item_id !== "string" || typeof raw.delta !== "string") break;
      const callId = ctx.toolCallItemIds.get(raw.item_id) ?? raw.item_id;
      if (ctx.endedToolCalls.has(callId) || ctx.stateToolCallIds.has(callId)) break;
      // TOOL_CALL_START is emitted from the run_item `tool_called` event, which
      // carries the tool name. If args stream before the item (ordering varies),
      // we buffer them; TOOL_CALL_ARGS deltas are only emitted once the call is
      // open to avoid emitting args with no parent TOOL_CALL_START.
      const prev = ctx.toolCallArgs.get(callId) ?? "";
      ctx.toolCallArgs.set(callId, prev + raw.delta);
      ctx.updateAssistantToolCallArgs(callId, prev + raw.delta);
      if (ctx.openToolCalls.has(callId)) {
        events.push({
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: callId,
          delta: raw.delta,
        });
      }
      break;
    }
    case "response.function_call_arguments.done": {
      if (typeof raw.item_id !== "string") break;
      const callId = ctx.toolCallItemIds.get(raw.item_id) ?? raw.item_id;
      if (ctx.endedToolCalls.has(callId)) break;
      if (typeof raw.arguments === "string") {
        const previous = ctx.toolCallArgs.get(callId) ?? "";
        if (raw.arguments.startsWith(previous)) {
          const remaining = raw.arguments.slice(previous.length);
          if (remaining && ctx.openToolCalls.has(callId)) {
            events.push({ type: EventType.TOOL_CALL_ARGS, toolCallId: callId, delta: remaining });
          }
          ctx.toolCallArgs.set(callId, raw.arguments);
          ctx.updateAssistantToolCallArgs(callId, raw.arguments);
        }
      }
      ctx.completedToolCallArgs.add(callId);
      if (ctx.pendingToolCallEnds.delete(callId)) {
        ctx.endedToolCalls.add(callId);
        events.push({ type: EventType.TOOL_CALL_END, toolCallId: callId });
      }
      break;
    }
    case "response.reasoning_summary_text.delta":
    case "response.reasoning_text.delta": {
      // Shape: { type, item_id, delta, output_index, sequence_number, ... }
      if (typeof raw.delta !== "string") break;
      const itemId = typeof raw.item_id === "string" ? raw.item_id : "reasoning";
      if (!ctx.reasoningOpen || ctx.currentReasoningId !== itemId) {
        if (ctx.reasoningOpen) {
          events.push({
            type: EventType.REASONING_MESSAGE_END,
            messageId: ctx.currentReasoningId!,
          });
        }
        ctx.currentReasoningId = itemId;
        ctx.reasoningOpen = true;
        events.push({
          type: EventType.REASONING_MESSAGE_START,
          messageId: itemId,
          role: "reasoning",
        });
      }
      events.push({
        type: EventType.REASONING_MESSAGE_CONTENT,
        messageId: itemId,
        delta: raw.delta,
      });
      break;
    }
    default:
      // Other raw model events (refusals, output_item.added, etc.) are not
      // mapped in Phase 2; the run_item events carry the higher-level truth.
      break;
  }
  return events;
}

/* ------------------------------ run item events ---------------------------- */

/**
 * Handle a `run_item_stream_event` (identified by `name`).
 *
 * `item` is a `RunItem` subclass. We read its `type` and `rawItem` to extract
 * the fields AG-UI cares about (tool name, call id, args, output).
 */
export function handleRunItemStreamEvent(
  name: string,
  item: any,
  ctx: StreamContext,
): BaseEvent[] {
  const events: BaseEvent[] = [];
  if (!item) return events;

  switch (name) {
    case "message_output_created":
      return handleMessageOutputCreated(item, ctx);

    case "tool_called":
      return handleToolCalled(item, ctx);

    case "tool_output":
      return handleToolOutput(item, ctx);

    case "reasoning_item_created":
      return handleReasoningItemCreated(item, ctx);

    case "tool_approval_requested":
    case "handoff_requested":
    case "handoff_occurred":
    case "tool_search_called":
    case "tool_search_output_created":
      // Surfaced as CUSTOM for now; full HITL pause/resume lands in Phase 5.
      events.push({
        type: EventType.CUSTOM,
        name,
        value: itemToJSON(item),
      });
      return events;

    default:
      return events;
  }
}

function handleMessageOutputCreated(item: any, ctx: StreamContext): BaseEvent[] {
  const events: BaseEvent[] = [];
  // Close any open reasoning block before the assistant message lands.
  if (ctx.reasoningOpen) {
    events.push({
      type: EventType.REASONING_MESSAGE_END,
      messageId: ctx.currentReasoningId!,
    });
    ctx.reasoningOpen = false;
  }
  // Close the streaming text message (text deltas already emitted its content).
  if (ctx.messageOpen) {
    events.push({
      type: EventType.TEXT_MESSAGE_END,
      messageId: ctx.currentMessageId!,
    });
    ctx.messageOpen = false;
    ctx.textMessageClosed = true;
  }
  return events;
}

function handleToolCalled(item: any, ctx: StreamContext): BaseEvent[] {
  const events: BaseEvent[] = [];
  const raw = item?.rawItem;
  if (!raw) return events;
  // function_call items carry callId/name/arguments; hosted/computer/etc.
  // calls carry callId too.
  const callId: string | undefined = raw.callId ?? raw.call_id;
  const toolName: string | undefined = raw.name;
  if (!callId) return events;

  if (toolName) ctx.toolCallNames.set(callId, toolName);

  // Intercept the state-management tool: the model passes the complete updated
  // state in the `state` arg; we emit a STATE_SNAPSHOT (replace semantics) and
  // do NOT surface it as a frontend tool call. (Phase 4.)
  if (toolName === STATE_MANAGEMENT_TOOL_NAME) {
    ctx.stateToolCallIds.add(callId);
    const argsStr =
      (typeof raw.arguments === "string" && raw.arguments) ||
      ctx.toolCallArgs.get(callId) || "";
    ctx.toolCallArgs.delete(callId);
    const updated = applyStateUpdate(ctx, argsStr, events);
    if (updated !== undefined) ctx.currentState = updated;
    return events;
  }

  // If args streamed before the item, emit them now as a single ARGS delta.
  const buffered = ctx.toolCallArgs.get(callId);
  const rawArgs = typeof raw.arguments === "string" ? raw.arguments : "";
  let hasCompleteRawArgs = false;
  if (rawArgs) {
    try {
      JSON.parse(rawArgs);
      hasCompleteRawArgs = true;
    } catch {
      // An incomplete JSON payload may be followed by more deltas.
    }
  }
  const effectiveArgs = hasCompleteRawArgs
    ? rawArgs
    : buffered && rawArgs.startsWith(buffered)
      ? rawArgs
      : buffered || rawArgs;

  const isFrontendTool =
    toolName != null && ctx.frontendToolNames.has(toolName);

  // SDK 0.12 emits tool_called after the model response completes, so its
  // arguments are complete before we halt consumption for a frontend tool.
  // Frontend tools are executed by the frontend, not the SDK. Close any open
  // text message so the stream ends in a valid state before the tool call,
  // emit the TOOL_CALL_* lifecycle, record the call, then halt the run with
  // an interrupt — do NOT emit TOOL_CALL_RESULT (the frontend provides it in a
  // subsequent run) and do NOT track the call as "open"; any SDK stub output
  // is discarded. (Phase 5.)
  if (isFrontendTool) {
    if (ctx.messageOpen) {
      events.push({
        type: EventType.TEXT_MESSAGE_END,
        messageId: ctx.currentMessageId!,
      });
      ctx.messageOpen = false;
    }
    events.push({
      type: EventType.TOOL_CALL_START,
      toolCallId: callId,
      toolCallName: toolName!,
    });
    if (effectiveArgs) {
      events.push({
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: callId,
        delta: effectiveArgs,
      });
    }
    events.push({
      type: EventType.TOOL_CALL_END,
      toolCallId: callId,
    });
    ctx.endedToolCalls.add(callId);
    ctx.recordAssistantToolCall(callId, toolName!, effectiveArgs);
    ctx.flushPendingAssistant(false);
    if (ctx.interruptFrontendTools) ctx.addInterrupt(callId, toolName!);
    else ctx.halt = true;
    return events;
  }

  // Backend / stub-executed tool: the SDK runs the stub `execute` and emits a
  // tool_output run_item, so track the call as open for the in-run result.
  ctx.openToolCalls.add(callId);
  ctx.toolCallArgs.set(callId, effectiveArgs);

  events.push({
    type: EventType.TOOL_CALL_START,
    toolCallId: callId,
    toolCallName: toolName ?? "tool",
  });

  if (effectiveArgs) {
    events.push({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: callId,
      delta: effectiveArgs,
    });
  }

  // Only a complete raw arguments payload or an explicit done event proves
  // that a backend call cannot receive further argument fragments.
  if (hasCompleteRawArgs || ctx.completedToolCallArgs.has(callId)) {
    events.push({ type: EventType.TOOL_CALL_END, toolCallId: callId });
    ctx.endedToolCalls.add(callId);
  } else {
    ctx.pendingToolCallEnds.add(callId);
  }

  // Record the call against the assistant message for MESSAGES_SNAPSHOT. (Phase 4.)
  ctx.recordAssistantToolCall(callId, toolName ?? "tool", effectiveArgs);
  return events;
}

function handleToolOutput(item: any, ctx: StreamContext): BaseEvent[] {
  const events: BaseEvent[] = [];
  const raw = item?.rawItem;
  const callId: string | undefined = raw?.callId ?? raw?.call_id;
  if (!callId) return [];

  // The state-management tool is intercepted; its stub execute still yields a
  // tool_output run_item, but we never emitted TOOL_CALL_START for it, so
  // swallow the result rather than emit a dangling TOOL_CALL_RESULT. (Phase 4.)
  if (ctx.stateToolCallIds.has(callId)) {
    ctx.stateToolCallIds.delete(callId);
    return [];
  }

  const toolName = ctx.toolCallNames.get(callId);
  if (toolName && ctx.frontendToolNames.has(toolName)) return [];

  if (ctx.pendingToolCallEnds.delete(callId)) {
    events.push({ type: EventType.TOOL_CALL_END, toolCallId: callId });
    ctx.endedToolCalls.add(callId);
  }
  if (ctx.messageOpen) {
    events.push({ type: EventType.TEXT_MESSAGE_END, messageId: ctx.currentMessageId! });
    ctx.messageOpen = false;
  }
  ctx.openToolCalls.delete(callId);
  ctx.toolCallArgs.delete(callId);
  ctx.toolCallNames.delete(callId);

  const content = outputToString(item?.output ?? raw?.output ?? "");

  // The assistant call must precede its tool result in conversation history.
  ctx.flushPendingAssistant();

  // Record the tool result message for MESSAGES_SNAPSHOT. (Phase 4.)
  ctx.upsertMessage({
    id: callId,
    role: "tool",
    toolCallId: callId,
    content,
  } as Message);

  events.push({
      type: EventType.TOOL_CALL_RESULT,
      messageId: callId,
      toolCallId: callId,
      content,
      role: "tool",
  });
  return events;
}

/**
 * Parse the `ag_ui_update_state` arguments and, when the new state differs from
 * the current one, push a `STATE_SNAPSHOT` event into `events`. Returns the new
 * state (or `undefined` to leave it unchanged) so the caller can update ctx.
 *
 * State-merge semantics: **replace** — the model passes the complete updated
 * state object in the `state` field (matches the tool description and the
 * `tools.test.ts` "replace vs. patch" pin).
 */
function applyStateUpdate(
  ctx: StreamContext,
  argsStr: string,
  events: BaseEvent[],
): unknown | undefined {
  if (!argsStr) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(argsStr);
  } catch {
    events.push({
      type: EventType.CUSTOM,
      name: "state_update_error",
      value: { error: "Failed to parse ag_ui_update_state arguments" },
    });
    return undefined;
  }

  // The tool schema declares a required `state` object; accept it directly.
  // Be lenient: a bare object passed without the wrapper is also accepted.
  const newState =
    parsed && typeof parsed === "object" && "state" in (parsed as Record<string, unknown>)
      ? (parsed as Record<string, unknown>).state
      : parsed;

  if (JSON.stringify(newState) === JSON.stringify(ctx.currentState)) return undefined;

  events.push({
    type: EventType.STATE_SNAPSHOT,
    snapshot: newState,
  });
  return newState;
}

function handleReasoningItemCreated(item: any, ctx: StreamContext): BaseEvent[] {
  // The reasoning summary deltas were already streamed as
  // REASONING_MESSAGE_CONTENT; this item signals the block is complete.
  const events: BaseEvent[] = [];
  if (ctx.reasoningOpen) {
    events.push({
      type: EventType.REASONING_MESSAGE_END,
      messageId: ctx.currentReasoningId!,
    });
    ctx.reasoningOpen = false;
  }
  return events;
}

function itemToJSON(item: any): unknown {
  try {
    return typeof item?.toJSON === "function" ? item.toJSON() : item;
  } catch {
    return undefined;
  }
}

/* --------------------------- agent updated event --------------------------- */

export function handleAgentUpdatedStreamEvent(
  agent: any,
): BaseEvent[] {
  return [
    {
      type: EventType.CUSTOM,
      name: "agent_updated",
      value: { name: agent?.name },
    },
  ];
}

/* ------------------------------ lifecycle helpers -------------------------- */

/**
 * Close any open message / reasoning block at end-of-stream. Returns events
 * to emit (if any) so the stream ends in a valid state.
 */
export function closeOpenBlocks(ctx: StreamContext): BaseEvent[] {
  const events: BaseEvent[] = [];
  if (ctx.messageOpen) {
    events.push({
      type: EventType.TEXT_MESSAGE_END,
      messageId: ctx.currentMessageId!,
    });
    ctx.messageOpen = false;
  }
  if (ctx.reasoningOpen) {
    events.push({
      type: EventType.REASONING_MESSAGE_END,
      messageId: ctx.currentReasoningId!,
    });
    ctx.reasoningOpen = false;
  }
  for (const callId of ctx.pendingToolCallEnds) {
    events.push({ type: EventType.TOOL_CALL_END, toolCallId: callId });
    ctx.endedToolCalls.add(callId);
  }
  ctx.pendingToolCallEnds.clear();
  // Flush any accumulated assistant message into the snapshot. (Phase 4.)
  ctx.flushPendingAssistant();
  return events;
}

/**
 * Build the MESSAGES_SNAPSHOT payload from the input messages plus any
 * assistant / tool messages accumulated from the stream during this run.
 *
 * Phase 4 merges in the generated messages (assistant text + tool calls +
 * tool results) tracked on the `StreamContext`. The signature accepts the
 * accumulated list so the adapter can pass `ctx.messages`.
 */
export function buildMessagesSnapshot(
  inputMessages: Message[],
  accumulated: Message[] = [],
): Message[] {
  return [...inputMessages, ...accumulated];
}

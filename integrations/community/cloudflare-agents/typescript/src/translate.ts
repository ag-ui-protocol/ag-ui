import {
  EventType,
  randomUUID,
  tokenUsageFromAiSdkUsage,
  aggregateTokenUsage,
  type AssistantMessage,
  type BaseEvent,
  type Interrupt,
  type Message,
  type ReasoningMessage,
  type TokenUsage,
  type ToolCall,
  type ToolMessage,
} from "@ag-ui/client";
import { mergeWithChannel, type EventChannel } from "./event-channel";
import { INTERRUPTED, REJECTED, approvalInterrupt, type PendingApproval } from "./messages";
import {
  encodeEnvelope,
  isRecord,
  mergeProviderMetadata,
  type ApprovalMarker,
  type ProviderMetadata,
} from "./provider-metadata";

/**
 * Anything with an AI SDK `fullStream`: a `streamText` result, or the result
 * of an AI SDK agent's `stream()`. AI SDK v6 and v7 both fit.
 */
export interface StreamTextLike {
  readonly fullStream: AsyncIterable<unknown>;
}

export interface TranslateOptions {
  /** The run's input messages; MESSAGES_SNAPSHOT is these plus the new ones. */
  inputMessages: Message[];
  /** Names of the tools the client runs. */
  clientToolNames?: Iterable<string>;
  /** Events produced beside the stream, interleaved as they arrive. */
  channel?: EventChannel;
  /** Why the user denied a call, by tool call id: the denied call's result. */
  denials?: ReadonlyMap<string, string>;
}

export type TranslationOutcome =
  | { type: "success" }
  | { type: "interrupt"; interrupts: Interrupt[] }
  | { type: "cancelled" }
  | { type: "error"; message: string; code: string };

export interface TranslationResult {
  outcome: TranslationOutcome;
  /** Token usage per provider and model, empty when the stream reported none. */
  usage: TokenUsage[];
  /** The calls this run paused for approval, for a server that records them. */
  approvals: PendingApproval[];
}

type Part = { type: string } & Record<string, unknown>;

const RESULT_PARTS = new Set(["tool-result", "tool-error", "tool-output-denied"]);

/**
 * Translates an AI SDK `fullStream` into AG-UI events: everything between
 * RUN_STARTED and the run's terminal event, ending with a MESSAGES_SNAPSHOT.
 * The generator's return value says how the run ended.
 */
export async function* translateStream(
  fullStream: AsyncIterable<unknown>,
  options: TranslateOptions,
): AsyncGenerator<BaseEvent, TranslationResult> {
  const t = new Translation(options);
  const items = options.channel
    ? mergeWithChannel(fullStream, options.channel)
    : wrapParts(fullStream);

  try {
    for await (const item of items) {
      if ("events" in item) {
        yield* item.events;
        continue;
      }
      const part = item.part as Part;
      if (!isRecord(part) || typeof part.type !== "string") continue;
      // What a tool emitted while it ran comes before its result.
      if (options.channel && RESULT_PARTS.has(part.type)) yield* options.channel.drain();
      yield* t.handle(part);
      if (t.stopped) break;
    }
  } catch (error) {
    // A stream that throws ends like one that sends an error part: whatever
    // is open is closed first, so no message is left streaming.
    t.fail(error);
  }
  yield* t.close();
  if (options.channel) yield* options.channel.drain();
  return t.result();
}

async function* wrapParts(stream: AsyncIterable<unknown>): AsyncGenerator<{ part: unknown }> {
  for await (const part of stream) yield { part };
}

interface CallState {
  toolCall: ToolCall;
  ended: boolean;
  metadata?: ProviderMetadata;
  approval?: ApprovalMarker;
}

interface ReasoningState {
  message: ReasoningMessage;
  started: boolean;
  metadata?: ProviderMetadata;
}

class Translation {
  /** Messages this run adds, in the order they began. */
  private readonly messages: Message[] = [];
  private readonly clientTools: Set<string>;
  /** The assistant message that holds this step's tool calls. */
  private holder: AssistantMessage | null = null;
  private text: { providerId: string; message: AssistantMessage; metadata?: ProviderMetadata } | null = null;
  /** Provider metadata of text blocks, by provider id, until their message starts. */
  private readonly textMetadata = new Map<string, ProviderMetadata | undefined>();
  private readonly reasoning = new Map<string, ReasoningState>();
  private readonly calls = new Map<string, CallState>();
  private readonly answered = new Set<string>();
  private readonly interrupts: Interrupt[] = [];
  private readonly approvals: PendingApproval[] = [];
  private readonly stepUsage: TokenUsage[] = [];
  private totalUsage: unknown;
  private step = 0;
  private stepOpen = false;
  private cancelled = false;
  private error: { message: string; code: string } | null = null;

  constructor(private readonly options: TranslateOptions) {
    this.clientTools = new Set(options.clientToolNames ?? []);
  }

  fail(error: unknown): void {
    this.error ??= { message: errorMessage(error), code: "STREAM_ERROR" };
  }

  get stopped(): boolean {
    return this.cancelled || this.error !== null;
  }

  *handle(part: Part): Generator<BaseEvent> {
    switch (part.type) {
      case "text-start":
        // Started lazily on the first non-empty delta, so an empty text block
        // leaves no empty message behind.
        this.noteTextMetadata(String(part.id ?? ""), part.providerMetadata);
        break;
      case "text-delta": {
        const providerId = String(part.id ?? "");
        this.noteTextMetadata(providerId, part.providerMetadata);
        const delta = typeof part.text === "string" ? part.text : "";
        if (!delta) break;
        if (!this.text || this.text.providerId !== providerId) {
          yield* this.endText();
          yield* this.startText(providerId);
        }
        const message = this.text!.message;
        message.content = (message.content ?? "") + delta;
        yield event({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: message.id, delta });
        break;
      }
      case "text-end": {
        const providerId = String(part.id ?? "");
        this.noteTextMetadata(providerId, part.providerMetadata);
        if (this.text && this.text.providerId === providerId) yield* this.endText();
        this.textMetadata.delete(providerId);
        break;
      }

      case "reasoning-start":
        this.reasoningFor(String(part.id ?? ""), part.providerMetadata);
        break;
      case "reasoning-delta": {
        const state = this.reasoningFor(String(part.id ?? ""), part.providerMetadata);
        const delta = typeof part.text === "string" ? part.text : "";
        if (!delta) break;
        yield* this.startReasoning(state);
        state.message.content += delta;
        yield event({
          type: EventType.REASONING_MESSAGE_CONTENT,
          messageId: state.message.id,
          delta,
        });
        break;
      }
      case "reasoning-end": {
        const id = String(part.id ?? "");
        const state = this.reasoningFor(id, part.providerMetadata);
        yield* this.endReasoning(id, state);
        break;
      }

      case "tool-input-start":
        yield* this.endText();
        yield* this.startCall(String(part.id), String(part.toolName), part.providerMetadata);
        break;
      case "tool-input-delta": {
        const call = this.calls.get(String(part.id));
        const delta = typeof part.delta === "string" ? part.delta : "";
        if (!call || call.ended || !delta) break;
        call.toolCall.function.arguments += delta;
        yield event({ type: EventType.TOOL_CALL_ARGS, toolCallId: call.toolCall.id, delta });
        break;
      }
      case "tool-input-end": {
        const call = this.calls.get(String(part.id));
        if (call) yield* this.endCall(call);
        break;
      }
      case "tool-call":
        yield* this.toolCall(part);
        break;

      case "tool-result":
        if (part.preliminary === true) break;
        yield* this.toolResult(String(part.toolCallId), stringifyOutput(part.output));
        break;
      case "tool-error": {
        const message = errorMessage(part.error);
        yield* this.toolResult(String(part.toolCallId), JSON.stringify({ error: message }), message);
        break;
      }
      case "tool-output-denied": {
        const toolCallId = String(part.toolCallId);
        yield* this.toolResult(toolCallId, this.options.denials?.get(toolCallId) ?? REJECTED);
        break;
      }
      case "tool-approval-request":
        yield* this.approvalRequest(part);
        break;

      case "start-step":
        yield* this.endText();
        this.holder = null;
        this.step += 1;
        this.stepOpen = true;
        yield event({ type: EventType.STEP_STARTED, stepName: `step-${this.step}` });
        break;
      case "finish-step": {
        yield* this.endText();
        const response = isRecord(part.response) ? part.response : {};
        const usage = tokenUsageFromAiSdkUsage(part.usage, {
          provider: firstKey(part.providerMetadata),
          model: typeof response.modelId === "string" ? response.modelId : undefined,
        });
        if (usage) this.stepUsage.push(usage);
        if (this.stepOpen) {
          this.stepOpen = false;
          yield event({ type: EventType.STEP_FINISHED, stepName: `step-${this.step}` });
        }
        break;
      }
      case "finish":
        this.totalUsage = part.totalUsage;
        break;

      case "source": {
        const { type: _type, ...source } = part;
        yield event({ type: EventType.CUSTOM, name: "source", value: source });
        break;
      }
      case "file":
      case "reasoning-file": {
        const file = isRecord(part.file) ? part.file : {};
        yield event({
          type: EventType.CUSTOM,
          name: part.type,
          value: { mediaType: file.mediaType, base64: file.base64 },
        });
        break;
      }
      case "custom":
        yield event({
          type: EventType.CUSTOM,
          name: String(part.kind),
          value: part.providerMetadata ?? null,
        });
        break;
      case "raw":
        yield event({ type: EventType.RAW, event: part.rawValue, source: "ai-sdk" });
        break;

      case "abort":
        this.cancelled = true;
        break;
      case "error":
        this.error = { message: errorMessage(part.error), code: "STREAM_ERROR" };
        break;

      default:
        // start, ping, tool-approval-response, steering-message: nothing to show.
        break;
    }
  }

  /** Closes whatever is still open and emits the snapshot. */
  *close(): Generator<BaseEvent> {
    yield* this.endText();
    for (const [id, state] of [...this.reasoning]) yield* this.endReasoning(id, state);
    for (const call of this.calls.values()) yield* this.endCall(call);
    if (this.stepOpen) {
      this.stepOpen = false;
      yield event({ type: EventType.STEP_FINISHED, stepName: `step-${this.step}` });
    }
    if (this.error) return;

    if (this.cancelled) {
      // A server call cut off by the cancel would otherwise look like a call
      // waiting for approval on the next run.
      const pending = new Set(this.interrupts.map((i) => i.toolCallId));
      for (const [id, call] of this.calls) {
        if (this.answered.has(id) || pending.has(id)) continue;
        if (this.clientTools.has(call.toolCall.function.name)) continue;
        yield* this.toolResult(id, INTERRUPTED);
      }
    }

    yield event({
      type: EventType.MESSAGES_SNAPSHOT,
      messages: [...this.options.inputMessages, ...this.messages],
    });
  }

  result(): TranslationResult {
    const usage = this.stepUsage.length > 0
      ? aggregateTokenUsage(this.stepUsage)
      : [tokenUsageFromAiSdkUsage(this.totalUsage, {})].filter((u): u is TokenUsage => !!u);
    const approvals = this.error || this.cancelled ? [] : this.approvals;
    if (this.error) return { outcome: { type: "error", ...this.error }, usage, approvals };
    if (this.cancelled) return { outcome: { type: "cancelled" }, usage, approvals };
    if (this.interrupts.length > 0) {
      return { outcome: { type: "interrupt", interrupts: this.interrupts }, usage, approvals };
    }
    return { outcome: { type: "success" }, usage, approvals };
  }

  private noteTextMetadata(providerId: string, metadata: unknown): void {
    if (this.text?.providerId === providerId) {
      this.text.metadata = mergeProviderMetadata(this.text.metadata, metadata);
    } else {
      this.textMetadata.set(providerId, mergeProviderMetadata(this.textMetadata.get(providerId), metadata));
    }
  }

  /**
   * A call the SDK paused for approval: an interrupt for the client, and a
   * marker on the call (in its `encryptedValue`) with the ids its resume
   * needs, so a later request can tell it from a call that was cut off.
   */
  private *approvalRequest(part: Part): Generator<BaseEvent> {
    // Decided by the SDK itself (v7 automatic approvals): nothing to ask.
    if (part.isAutomatic === true) return;
    const toolCall = isRecord(part.toolCall) ? part.toolCall : {};
    const toolCallId = String(toolCall.toolCallId);
    const toolName = String(toolCall.toolName);
    const approvalId = typeof part.approvalId === "string" ? part.approvalId : toolCallId;
    this.interrupts.push(approvalInterrupt(toolCallId, toolName, toolCall.input));
    this.approvals.push({ toolCallId, approvalId, toolName, input: toolCall.input });

    const call = this.calls.get(toolCallId);
    if (!call) return;
    call.approval = {
      approvalId,
      ...(typeof part.signature === "string" && { signature: part.signature }),
    };
    yield* this.emitCallEnvelope(call);
  }

  private *emitCallEnvelope(call: CallState): Generator<BaseEvent> {
    const encryptedValue = encodeEnvelope({ providerMetadata: call.metadata, approval: call.approval });
    if (!encryptedValue) return;
    call.toolCall.encryptedValue = encryptedValue;
    yield event({
      type: EventType.REASONING_ENCRYPTED_VALUE,
      subtype: "tool-call",
      entityId: call.toolCall.id,
      encryptedValue,
    });
  }

  private *startText(providerId: string): Generator<BaseEvent> {
    const message: AssistantMessage = { id: randomUUID(), role: "assistant", content: "" };
    this.messages.push(message);
    this.text = { providerId, message, metadata: this.textMetadata.get(providerId) };
    this.textMetadata.delete(providerId);
    // Tool calls later in this step belong to the latest text message.
    this.holder = message;
    yield event({ type: EventType.TEXT_MESSAGE_START, messageId: message.id, role: "assistant" });
  }

  private *endText(): Generator<BaseEvent> {
    if (!this.text) return;
    const { message, metadata } = this.text;
    this.text = null;
    yield event({ type: EventType.TEXT_MESSAGE_END, messageId: message.id });
    // OpenAI's Responses API, for one, ties a message to a stored item.
    const encryptedValue = encodeEnvelope({ providerMetadata: metadata });
    if (encryptedValue) {
      message.encryptedValue = encryptedValue;
      yield event({
        type: EventType.REASONING_ENCRYPTED_VALUE,
        subtype: "message",
        entityId: message.id,
        encryptedValue,
      });
    }
  }

  private reasoningFor(providerId: string, metadata: unknown): ReasoningState {
    let state = this.reasoning.get(providerId);
    if (!state) {
      state = { message: { id: randomUUID(), role: "reasoning", content: "" }, started: false };
      this.reasoning.set(providerId, state);
    }
    state.metadata = mergeProviderMetadata(state.metadata, metadata);
    return state;
  }

  private *startReasoning(state: ReasoningState): Generator<BaseEvent> {
    if (state.started) return;
    state.started = true;
    this.messages.push(state.message);
    const messageId = state.message.id;
    yield event({ type: EventType.REASONING_START, messageId });
    yield event({ type: EventType.REASONING_MESSAGE_START, messageId, role: "reasoning" });
  }

  private *endReasoning(providerId: string, state: ReasoningState): Generator<BaseEvent> {
    this.reasoning.delete(providerId);
    const encryptedValue = encodeEnvelope({ providerMetadata: state.metadata });
    // A block with neither text nor provider data (an empty summary) is noise.
    if (!state.started && !encryptedValue) return;
    yield* this.startReasoning(state);
    const messageId = state.message.id;
    yield event({ type: EventType.REASONING_MESSAGE_END, messageId });
    yield event({ type: EventType.REASONING_END, messageId });
    if (encryptedValue) {
      state.message.encryptedValue = encryptedValue;
      yield event({
        type: EventType.REASONING_ENCRYPTED_VALUE,
        subtype: "message",
        entityId: messageId,
        encryptedValue,
      });
    }
  }

  private *startCall(toolCallId: string, toolName: string, metadata: unknown): Generator<BaseEvent> {
    if (this.calls.has(toolCallId)) return;
    if (!this.holder) {
      this.holder = { id: randomUUID(), role: "assistant" };
      this.messages.push(this.holder);
    }
    const toolCall: ToolCall = {
      id: toolCallId,
      type: "function",
      function: { name: toolName, arguments: "" },
    };
    (this.holder.toolCalls ??= []).push(toolCall);
    this.calls.set(toolCallId, {
      toolCall,
      ended: false,
      metadata: mergeProviderMetadata(undefined, metadata),
    });
    yield event({
      type: EventType.TOOL_CALL_START,
      toolCallId,
      toolCallName: toolName,
      parentMessageId: this.holder.id,
    });
  }

  private *endCall(call: CallState): Generator<BaseEvent> {
    if (call.ended) return;
    call.ended = true;
    yield event({ type: EventType.TOOL_CALL_END, toolCallId: call.toolCall.id });
  }

  private *toolCall(part: Part): Generator<BaseEvent> {
    const toolCallId = String(part.toolCallId);
    const args = typeof part.input === "string" ? part.input : JSON.stringify(part.input ?? {});
    let call = this.calls.get(toolCallId);
    if (!call) {
      yield* this.endText();
      yield* this.startCall(toolCallId, String(part.toolName), undefined);
      call = this.calls.get(toolCallId)!;
      if (args) yield event({ type: EventType.TOOL_CALL_ARGS, toolCallId, delta: args });
    }
    yield* this.endCall(call);
    // The parsed input is the canonical form; streamed deltas may differ in spacing.
    call.toolCall.function.arguments = args;

    call.metadata = mergeProviderMetadata(call.metadata, part.providerMetadata);
    yield* this.emitCallEnvelope(call);
  }

  private *toolResult(toolCallId: string, content: string, error?: string): Generator<BaseEvent> {
    if (this.answered.has(toolCallId)) return;
    this.answered.add(toolCallId);
    const message: ToolMessage = {
      id: randomUUID(),
      role: "tool",
      toolCallId,
      content,
      ...(error !== undefined && { error }),
    };
    this.messages.push(message);
    yield event({
      type: EventType.TOOL_CALL_RESULT,
      messageId: message.id,
      toolCallId,
      content,
      role: "tool",
    });
  }
}

function event<T extends { type: EventType }>(body: T): BaseEvent & T {
  return { ...body, timestamp: Date.now() } as BaseEvent & T;
}

function stringifyOutput(output: unknown): string {
  if (typeof output === "string") return output;
  if (output === undefined) return "";
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (isRecord(error) && typeof error.message === "string") return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function firstKey(value: unknown): string | undefined {
  return isRecord(value) ? Object.keys(value)[0] : undefined;
}

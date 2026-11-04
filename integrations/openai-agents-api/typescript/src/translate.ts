import { EventType, type BaseEvent } from "@ag-ui/core";
import { parseArguments } from "./tools";
import type { PredictStateConfig, SessionEvent } from "./types";

/** A function call the agent made, as surfaced to the client. */
export interface SurfacedFunctionCall {
  callId: string;
  turnId: string;
  name: string;
  arguments: unknown;
}

export interface TranslatorOptions {
  emit: (event: BaseEvent) => void;
  /** Whether an OpenAI item was already surfaced by an earlier run (stream replays). */
  isSurfaced: (itemId: string) => boolean;
  markSurfaced: (itemId: string) => void;
  /** Called once per function call, right after its TOOL_CALL_* events. */
  onFunctionCall: (call: SurfacedFunctionCall) => void;
  predictState?: PredictStateConfig[];
  /**
   * Called with the state a predicted tool call settles on, between its
   * TOOL_CALL_ARGS and TOOL_CALL_END, so the prediction becomes authoritative.
   */
  onPredictedState?: (update: Record<string, unknown>) => void;
  /** Attach the answer's markdown links as `metadata.citations` on TEXT_MESSAGE_END. */
  extractLinkCitations?: boolean;
}

/** A source the answer links to, in the shape the AG-UI citation demos read. */
export interface LinkCitation {
  title: string;
  source: string;
  location: { type: "web"; url: string; domain?: string };
  /** UTF-16 offset in the answer just after the link. */
  textOffset: number;
}

const LINK_PATTERN = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;

/** Markdown links in `text`, one citation per distinct URL. */
export const linkCitations = (text: string): LinkCitation[] => {
  const citations: LinkCitation[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(LINK_PATTERN)) {
    const [whole, title, url] = match;
    if (seen.has(url)) continue;
    seen.add(url);
    let domain: string | undefined;
    try {
      domain = new URL(url).hostname.replace(/^www\./, "");
    } catch {
      domain = undefined;
    }
    citations.push({
      title,
      source: url,
      location: { type: "web", url, ...(domain ? { domain } : {}) },
      textOffset: (match.index ?? 0) + whole.length,
    });
  }
  return citations;
};

type Item = Extract<
  SessionEvent,
  { type: "agent.session.turn.item.added" }
>["item"];

/** Item types the agent runs itself (built-in tools, subagents). Shown once complete. */
const HOSTED_TOOL_TITLES: Record<string, string> = {
  web_search_call: "web_search",
  mcp_call: "mcp",
  command_execution: "command_execution",
  computer_use_call: "computer_use",
  create_subagent_call: "create_subagent",
  send_subagent_input_call: "send_subagent_input",
  resume_subagent_call: "resume_subagent",
  wait_for_subagents_call: "wait_for_subagents",
  interrupt_subagent_call: "interrupt_subagent",
  close_subagent_call: "close_subagent",
};

const stringifyArgs = (args: unknown): string => {
  if (typeof args === "string") return args;
  if (args === undefined || args === null) return "{}";
  return JSON.stringify(args);
};

const OMIT_FROM_ARGS = new Set([
  "id",
  "type",
  "turn_id",
  "status",
  "output",
  "error",
]);

/** Arguments and result for an item the agent executed itself. */
const describeHostedItem = (
  item: Record<string, unknown>,
): { name: string; args: string; result: string } => {
  const type = String(item.type);
  if (type === "mcp_call") {
    const name = `${String(item.server_label)}.${String(item.name)}`;
    const result = item.error ? { error: item.error } : item.output;
    return {
      name,
      args: stringifyArgs(item.arguments),
      result:
        typeof result === "string" ? result : JSON.stringify(result ?? null),
    };
  }
  if (type === "web_search_call") {
    const action = (item.action ?? {}) as Record<string, unknown>;
    return {
      name: "web_search",
      args: JSON.stringify(action),
      result: JSON.stringify({ status: item.status, ...action }),
    };
  }
  if (type === "command_execution") {
    return {
      name: "command_execution",
      args: JSON.stringify({ command: item.command, cwd: item.cwd }),
      result: JSON.stringify({
        exit_code: item.exit_code,
        output: item.output,
      }),
    };
  }
  const args: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(item)) {
    if (!OMIT_FROM_ARGS.has(key)) args[key] = value;
  }
  const result = item.error
    ? { status: item.status, error: item.error }
    : { status: item.status, output: item.output ?? null };
  return {
    name: HOSTED_TOOL_TITLES[type] ?? type,
    args: JSON.stringify(args),
    result: JSON.stringify(result),
  };
};

interface OpenText {
  /** The text so far, for citation extraction. */
  text: string;
  /** Text received per content index; a part's `done` adds only what is missing. */
  received: Map<number, string>;
  /** Content indexes that produced text, to separate parts. */
  written: Set<number>;
}

interface OpenReasoning {
  messageStarted: boolean;
  received: Map<number, string>;
  written: Set<number>;
}

/**
 * The part of `full` not received yet. A reconnect can drop deltas, and the
 * replay then carries the whole text in its `done` event.
 */
const missingSuffix = (received: string, full: string): string =>
  full.startsWith(received) ? full.slice(received.length) : "";

/**
 * Translates one run's worth of Agents API session events into AG-UI events.
 *
 * The session stream replays the active turn's items whenever it is opened, so
 * every item is checked against the ids surfaced by earlier runs and dropped
 * when the client already has it.
 */
export class EventTranslator {
  private readonly texts = new Map<string, OpenText>();
  private readonly reasoning = new Map<string, OpenReasoning>();
  /** Items surfaced in an earlier run: their remaining events are dropped. */
  private readonly replayed = new Set<string>();
  /** Turns that belong to subagents. Their output is not the conversation. */
  private readonly subagentTurns = new Set<string>();
  /** The assistant message the next tool call belongs to (the text that preceded it). */
  private parentMessageId: string | undefined;

  constructor(private readonly options: TranslatorOptions) {}

  /** True while a text or reasoning message is mid-stream. */
  get streaming(): boolean {
    return this.texts.size > 0 || this.reasoning.size > 0;
  }

  handle(event: SessionEvent): void {
    switch (event.type) {
      case "agent.session.turn.created":
      case "agent.session.turn.in_progress":
        if (event.turn.subagent_id) this.subagentTurns.add(event.turn_id);
        return;
      case "agent.session.turn.item.added":
        if (this.fromSubagent(event.turn_id)) return;
        this.itemAdded(event.item);
        return;
      case "agent.session.turn.item.done":
        if (this.fromSubagent(event.turn_id)) return;
        this.itemDone(event.item as Item);
        return;
      case "agent.session.turn.content_part.added":
        if (
          this.fromSubagent(event.turn_id) ||
          this.replayed.has(event.item_id)
        )
          return;
        this.ensureText(event.item_id);
        return;
      case "agent.session.turn.output_text.delta":
        if (
          this.fromSubagent(event.turn_id) ||
          this.replayed.has(event.item_id)
        )
          return;
        this.textDelta(event.item_id, event.content_index, event.delta);
        return;
      case "agent.session.turn.output_text.done":
        if (
          this.fromSubagent(event.turn_id) ||
          this.replayed.has(event.item_id)
        )
          return;
        {
          const open = this.ensureText(event.item_id);
          const missing = open
            ? missingSuffix(
                open.received.get(event.content_index) ?? "",
                event.text,
              )
            : "";
          if (missing)
            this.textDelta(event.item_id, event.content_index, missing);
        }
        return;
      case "agent.session.turn.reasoning_summary_part.added":
        if (
          this.fromSubagent(event.turn_id) ||
          this.replayed.has(event.item_id)
        )
          return;
        this.ensureReasoningMessage(event.item_id);
        return;
      case "agent.session.turn.reasoning_summary_text.delta":
        if (
          this.fromSubagent(event.turn_id) ||
          this.replayed.has(event.item_id)
        )
          return;
        this.reasoningDelta(event.item_id, event.summary_index, event.delta);
        return;
      case "agent.session.turn.reasoning_summary_text.done": {
        if (
          this.fromSubagent(event.turn_id) ||
          this.replayed.has(event.item_id)
        )
          return;
        const open = this.ensureReasoning(event.item_id);
        const missing = open
          ? missingSuffix(
              open.received.get(event.summary_index) ?? "",
              event.text,
            )
          : "";
        if (missing)
          this.reasoningDelta(event.item_id, event.summary_index, missing);
        return;
      }
      default:
        return;
    }
  }

  /** Close every message still open, so the run never ends mid-message. */
  closeAll(): void {
    for (const itemId of [...this.texts.keys()]) this.endText(itemId);
    for (const itemId of [...this.reasoning.keys()]) this.endReasoning(itemId);
  }

  private fromSubagent(turnId: string | null | undefined): boolean {
    return !!turnId && this.subagentTurns.has(turnId);
  }

  /** Claims an item for this run. False when an earlier run already surfaced it. */
  private claim(itemId: string): boolean {
    if (this.replayed.has(itemId)) return false;
    if (this.texts.has(itemId) || this.reasoning.has(itemId)) return true;
    if (this.options.isSurfaced(itemId)) {
      this.replayed.add(itemId);
      return false;
    }
    this.options.markSurfaced(itemId);
    return true;
  }

  private itemAdded(item: Item): void {
    switch (item.type) {
      case "message":
        if (!item.id) return;
        if (item.role === "assistant") this.ensureText(item.id);
        else this.options.markSurfaced(item.id);
        return;
      case "reasoning":
        this.ensureReasoning(item.id);
        return;
      case "function_call":
        if (!this.claim(item.call_id)) return;
        this.emitFunctionCall({
          callId: item.call_id,
          turnId: item.turn_id,
          name: item.name,
          arguments: item.arguments,
        });
        return;
      default:
        // Function call outputs are inputs we (or the client) supplied; hosted
        // tool items are surfaced once complete, when their result is known.
        return;
    }
  }

  private itemDone(item: Item): void {
    switch (item.type) {
      case "message": {
        const itemId = item.id;
        const open = itemId ? this.texts.get(itemId) : undefined;
        if (itemId && open) {
          // Whatever never arrived as deltas (a replayed, delta-less or
          // reconnected message) is in the finished item.
          (item.content ?? []).forEach((part, index) => {
            const full = "text" in part ? part.text : "";
            const missing = missingSuffix(open.received.get(index) ?? "", full);
            if (missing) this.textDelta(itemId, index, missing);
          });
          this.endText(itemId);
        }
        return;
      }
      case "reasoning":
        if (this.reasoning.has(item.id)) {
          const open = this.reasoning.get(item.id)!;
          (item.summary ?? []).forEach((part, index) => {
            const missing = missingSuffix(
              open.received.get(index) ?? "",
              part.text,
            );
            if (missing) this.reasoningDelta(item.id, index, missing);
          });
          this.endReasoning(item.id);
        }
        return;
      case "function_call":
        // Normally surfaced on item.added; this catches a stream that skipped it.
        if (!this.claim(item.call_id)) return;
        this.emitFunctionCall({
          callId: item.call_id,
          turnId: item.turn_id,
          name: item.name,
          arguments: item.arguments,
        });
        return;
      default:
        if (item.type in HOSTED_TOOL_TITLES || item.type.endsWith("_call")) {
          if (!this.claim(item.id)) return;
          this.emitHostedTool(item as unknown as Record<string, unknown>);
        }
        return;
    }
  }

  /** Surfaces a function call the agent is waiting on (from required_actions). */
  surfaceFunctionCall(call: SurfacedFunctionCall): void {
    if (!this.claim(call.callId)) return;
    this.emitFunctionCall(call);
  }

  private emitFunctionCall(call: SurfacedFunctionCall): void {
    const { emit } = this.options;
    const predictions = (this.options.predictState ?? []).filter(
      (entry) => entry.tool === call.name,
    );
    if (predictions.length) {
      emit({
        type: EventType.CUSTOM,
        name: "PredictState",
        value: predictions.map((entry) => ({
          state_key: entry.stateKey,
          tool: entry.tool,
          tool_argument: entry.toolArgument,
        })),
      } as BaseEvent);
    }
    emit({
      type: EventType.TOOL_CALL_START,
      toolCallId: call.callId,
      toolCallName: call.name,
      ...(this.parentMessageId
        ? { parentMessageId: this.parentMessageId }
        : {}),
    } as BaseEvent);
    emit({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: call.callId,
      delta: stringifyArgs(call.arguments),
    } as BaseEvent);
    if (predictions.length && this.options.onPredictedState) {
      const args = parseArguments(call.arguments);
      const update: Record<string, unknown> = {};
      for (const entry of predictions) {
        if (entry.toolArgument in args)
          update[entry.stateKey] = args[entry.toolArgument];
      }
      if (Object.keys(update).length) this.options.onPredictedState(update);
    }
    emit({
      type: EventType.TOOL_CALL_END,
      toolCallId: call.callId,
    } as BaseEvent);
    this.options.onFunctionCall(call);
  }

  private emitHostedTool(item: Record<string, unknown>): void {
    const { emit } = this.options;
    const toolCallId = String(item.id);
    const { name, args, result } = describeHostedItem(item);
    emit({
      type: EventType.TOOL_CALL_START,
      toolCallId,
      toolCallName: name,
      ...(this.parentMessageId
        ? { parentMessageId: this.parentMessageId }
        : {}),
    } as BaseEvent);
    emit({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId,
      delta: args,
    } as BaseEvent);
    emit({ type: EventType.TOOL_CALL_END, toolCallId } as BaseEvent);
    emit({
      type: EventType.TOOL_CALL_RESULT,
      messageId: `${toolCallId}-result`,
      toolCallId,
      content: result,
      role: "tool",
    } as BaseEvent);
  }

  private ensureText(itemId: string): OpenText | undefined {
    const open = this.texts.get(itemId);
    if (open) return open;
    if (!this.claim(itemId)) return undefined;
    const created: OpenText = {
      text: "",
      received: new Map(),
      written: new Set(),
    };
    this.texts.set(itemId, created);
    this.parentMessageId = itemId;
    this.options.emit({
      type: EventType.TEXT_MESSAGE_START,
      messageId: itemId,
      role: "assistant",
    } as BaseEvent);
    return created;
  }

  private textDelta(itemId: string, contentIndex: number, delta: string): void {
    const open = this.ensureText(itemId);
    if (!open || !delta) return;
    open.received.set(
      contentIndex,
      (open.received.get(contentIndex) ?? "") + delta,
    );
    // Separate a new content part from the text before it.
    const prefix =
      !open.written.has(contentIndex) && open.written.size > 0 ? "\n\n" : "";
    open.written.add(contentIndex);
    open.text += prefix + delta;
    this.options.emit({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: itemId,
      delta: prefix + delta,
    } as BaseEvent);
  }

  private endText(itemId: string): void {
    const open = this.texts.get(itemId);
    this.texts.delete(itemId);
    const citations =
      this.options.extractLinkCitations && open ? linkCitations(open.text) : [];
    this.options.emit({
      type: EventType.TEXT_MESSAGE_END,
      messageId: itemId,
      ...(citations.length ? { metadata: { citations } } : {}),
    } as BaseEvent);
  }

  private ensureReasoning(itemId: string): OpenReasoning | undefined {
    const open = this.reasoning.get(itemId);
    if (open) return open;
    if (!this.claim(itemId)) return undefined;
    const created: OpenReasoning = {
      messageStarted: false,
      received: new Map(),
      written: new Set(),
    };
    this.reasoning.set(itemId, created);
    this.options.emit({
      type: EventType.REASONING_START,
      messageId: itemId,
    } as BaseEvent);
    return created;
  }

  private ensureReasoningMessage(itemId: string): OpenReasoning | undefined {
    const open = this.ensureReasoning(itemId);
    if (open && !open.messageStarted) {
      open.messageStarted = true;
      this.options.emit({
        type: EventType.REASONING_MESSAGE_START,
        messageId: itemId,
        role: "reasoning",
      } as BaseEvent);
    }
    return open;
  }

  private reasoningDelta(
    itemId: string,
    summaryIndex: number,
    delta: string,
  ): void {
    const open = this.ensureReasoningMessage(itemId);
    if (!open || !delta) return;
    open.received.set(
      summaryIndex,
      (open.received.get(summaryIndex) ?? "") + delta,
    );
    const prefix =
      !open.written.has(summaryIndex) && open.written.size > 0 ? "\n\n" : "";
    open.written.add(summaryIndex);
    this.options.emit({
      type: EventType.REASONING_MESSAGE_CONTENT,
      messageId: itemId,
      delta: prefix + delta,
    } as BaseEvent);
  }

  private endReasoning(itemId: string): void {
    const open = this.reasoning.get(itemId);
    this.reasoning.delete(itemId);
    if (open?.messageStarted) {
      this.options.emit({
        type: EventType.REASONING_MESSAGE_END,
        messageId: itemId,
      } as BaseEvent);
    }
    this.options.emit({
      type: EventType.REASONING_END,
      messageId: itemId,
    } as BaseEvent);
  }
}

import { createHash } from "node:crypto";
import {
  EventType,
  type BaseEvent,
  type Message,
  type TokenUsage,
} from "@ag-ui/core";
import type { ThreadEvent, ThreadItem, Usage } from "@openai/codex-sdk";
import { CodexAdapterError } from "./errors";

type TranslatorOptions = {
  runId: string;
  showReasoning?: boolean;
  maxTextBytes?: number;
  maxItems?: number;
  maxProgressBytes?: number;
  maxMessages?: number;
};

type TextItem = {
  id: string;
  messageId: string;
  kind: "agent_message" | "reasoning";
  text: string;
  emitted: number;
  complete: boolean;
  started: boolean;
};

export class CodexEventTranslator {
  private readonly options: Required<TranslatorOptions>;
  private readonly seen = new Map<string, ThreadItem["type"]>();
  private readonly pending = new Map<string, TextItem>();
  private readonly completedText = new Map<string, string>();
  private readonly queue: TextItem[] = [];
  private readonly assistantMessages: Message[] = [];
  private observedBytes = 0;
  private success = false;
  private usage?: TokenUsage;
  private closed = false;

  constructor(options: TranslatorOptions) {
    this.options = {
      showReasoning: false,
      maxTextBytes: 4 * 1024 * 1024,
      maxItems: 1000,
      maxProgressBytes: 16 * 1024,
      maxMessages: 2000,
      ...options,
    };
  }

  push(event: ThreadEvent): BaseEvent[] {
    if (this.closed) return [];
    switch (event.type) {
      case "thread.started":
      case "turn.started":
        return [];
      case "turn.completed":
        if (!this.success) this.usage = mapUsage(event.usage);
        this.success = true;
        return [];
      case "turn.failed":
      case "error":
        throw new CodexAdapterError(
          "CODEX_RUN_FAILED",
          "Codex could not complete this turn. Start a new thread.",
        );
      case "item.started":
      case "item.updated":
      case "item.completed": {
        if (this.success) {
          throw new CodexAdapterError(
            "STREAM_INCONSISTENT",
            "Codex sent an item after completing the turn.",
          );
        }
        const item = event.item;
        if (
          !item ||
          typeof item.id !== "string" ||
          typeof item.type !== "string"
        ) {
          throw new CodexAdapterError(
            "INVALID_SDK_EVENT",
            "Codex returned an invalid item.",
          );
        }
        const previousKind = this.seen.get(item.id);
        if (previousKind && previousKind !== item.type) {
          throw new CodexAdapterError(
            "STREAM_INCONSISTENT",
            "Codex changed an item's type.",
          );
        }
        if (!previousKind) {
          if (this.seen.size >= this.options.maxItems) {
            throw new CodexAdapterError(
              "ITEM_LIMIT",
              "Codex exceeded the native item limit.",
            );
          }
          this.seen.set(item.id, item.type);
        }
        if (item.type === "agent_message" || item.type === "reasoning") {
          return this.text(
            item,
            event.type === "item.completed",
            previousKind !== undefined,
          );
        }
        return [this.progress(item, event.type)];
      }
      default: {
        const _exhaustive: never = event;
        throw new CodexAdapterError(
          "INVALID_SDK_EVENT",
          "Codex returned an unknown event.",
        );
      }
    }
  }

  finish(): {
    events: BaseEvent[];
    assistantMessages: Message[];
    usage?: TokenUsage;
  } {
    if (!this.success) {
      throw new CodexAdapterError(
        "INCOMPLETE_STREAM",
        "Codex ended without completing the turn.",
      );
    }
    if (this.queue.length) {
      throw new CodexAdapterError(
        "INCOMPLETE_STREAM",
        "Codex ended with an unfinished message.",
      );
    }
    this.closed = true;
    return {
      events: [],
      assistantMessages: this.assistantMessages,
      usage: this.usage,
    };
  }

  close(): BaseEvent[] {
    if (this.closed) return [];
    this.closed = true;
    const first = this.queue[0];
    const events = first?.started ? this.end(first) : [];
    this.queue.length = 0;
    this.pending.clear();
    return events;
  }

  private text(
    item: Extract<ThreadItem, { type: "agent_message" | "reasoning" }>,
    complete: boolean,
    seen: boolean,
  ): BaseEvent[] {
    if (typeof item.text !== "string") {
      throw new CodexAdapterError(
        "INVALID_SDK_EVENT",
        "Codex returned invalid message text.",
      );
    }
    let state = this.pending.get(item.id);
    if (seen && !state) {
      if (this.completedText.get(item.id) !== fingerprint(item.text)) {
        throw new CodexAdapterError(
          "STREAM_INCONSISTENT",
          "Codex revised a completed message.",
        );
      }
      return [];
    }
    if (!state) {
      if (
        item.type === "agent_message" &&
        this.assistantMessages.length +
          this.queue.filter((entry) => entry.kind === "agent_message").length >=
          this.options.maxMessages
      ) {
        throw new CodexAdapterError(
          "SESSION_MESSAGE_LIMIT",
          "This session has reached its message limit. Start a new thread.",
        );
      }
      state = {
        id: item.id,
        messageId: `${this.options.runId}:codex:${item.id}`,
        kind: item.type,
        text: "",
        emitted: 0,
        complete: false,
        started: false,
      };
      this.pending.set(item.id, state);
      this.queue.push(state);
    }
    if (state.complete && item.text !== state.text) {
      throw new CodexAdapterError(
        "STREAM_INCONSISTENT",
        "Codex revised a completed message.",
      );
    }
    if (!item.text.startsWith(state.text)) {
      throw new CodexAdapterError(
        "STREAM_INCONSISTENT",
        "Codex revised text that was already streamed.",
      );
    }
    const bytes = Buffer.byteLength(item.text, "utf8");
    const growth = bytes - Buffer.byteLength(state.text, "utf8");
    if (
      bytes > this.options.maxTextBytes ||
      this.observedBytes + growth > this.options.maxTextBytes
    ) {
      throw new CodexAdapterError(
        "TEXT_LIMIT",
        "Codex exceeded the text output limit.",
      );
    }
    this.observedBytes += growth;
    state.text = item.text;
    state.complete ||= complete;
    return this.flush();
  }

  private flush(): BaseEvent[] {
    const events: BaseEvent[] = [];
    while (this.queue.length) {
      const item = this.queue[0];
      if (!item) break;
      const visible =
        item.kind === "agent_message" || this.options.showReasoning;
      if (visible) {
        if (!item.started) {
          item.started = true;
          events.push(...this.start(item));
        }
        const delta = item.text.slice(item.emitted);
        if (delta) {
          events.push({
            type:
              item.kind === "agent_message"
                ? EventType.TEXT_MESSAGE_CONTENT
                : EventType.REASONING_MESSAGE_CONTENT,
            messageId: item.messageId,
            delta,
          });
          item.emitted = item.text.length;
        }
      }
      if (!item.complete) break;
      if (visible) events.push(...this.end(item));
      if (item.kind === "agent_message") {
        this.assistantMessages.push({
          id: item.messageId,
          role: "assistant",
          content: item.text,
        });
      }
      this.completedText.set(item.id, fingerprint(item.text));
      this.pending.delete(item.id);
      this.queue.shift();
    }
    return events;
  }

  private start(item: TextItem): BaseEvent[] {
    if (item.kind === "agent_message") {
      return [
        {
          type: EventType.TEXT_MESSAGE_START,
          messageId: item.messageId,
          role: "assistant",
        },
      ];
    }
    return [
      { type: EventType.REASONING_START, messageId: item.messageId },
      {
        type: EventType.REASONING_MESSAGE_START,
        messageId: item.messageId,
        role: "reasoning",
      },
    ];
  }

  private end(item: TextItem): BaseEvent[] {
    if (item.kind === "agent_message")
      return [{ type: EventType.TEXT_MESSAGE_END, messageId: item.messageId }];
    return [
      { type: EventType.REASONING_MESSAGE_END, messageId: item.messageId },
      { type: EventType.REASONING_END, messageId: item.messageId },
    ];
  }

  private progress(
    item: Exclude<ThreadItem, { type: "agent_message" | "reasoning" }>,
    phase: string,
  ): BaseEvent {
    const cap = this.options.maxProgressBytes;
    const text = (value: string) =>
      clip(value, Math.max(1, Math.floor(cap / 8)));
    const listLimit = Math.min(50, Math.max(1, Math.floor(cap / 128)));
    let truncated = false;
    const boundedText = (value: string) => {
      requireProgress(typeof value === "string");
      const result = text(value);
      truncated ||= result !== value;
      return result;
    };
    const identity = { id: boundedText(item.id), type: item.type };
    let projected: object;
    switch (item.type) {
      case "command_execution":
        requireProgress(
          isStatus(item.status, ["in_progress", "completed", "failed"]),
        );
        requireProgress(
          item.exit_code === undefined ||
            (typeof item.exit_code === "number" &&
              Number.isSafeInteger(item.exit_code)),
        );
        projected = {
          ...identity,
          command: boundedText(item.command),
          status: item.status,
          output: boundedText(item.aggregated_output),
          exitCode: item.exit_code,
        };
        break;
      case "mcp_tool_call":
        requireProgress(
          isStatus(item.status, ["in_progress", "completed", "failed"]),
        );
        requireProgress(
          item.result === undefined ||
            (isRecord(item.result) && Array.isArray(item.result.content)),
        );
        requireProgress(
          item.error === undefined ||
            (isRecord(item.error) && typeof item.error.message === "string"),
        );
        projected = {
          ...identity,
          server: boundedText(item.server),
          tool: boundedText(item.tool),
          status: item.status,
          argumentsSummary:
            item.arguments === null ? "null" : typeof item.arguments,
          resultSummary: item.result
            ? { contentCount: item.result.content.length }
            : undefined,
          errorCode: item.error ? "MCP_TOOL_FAILED" : undefined,
        };
        break;
      case "file_change":
        requireProgress(isStatus(item.status, ["completed", "failed"]));
        requireProgress(Array.isArray(item.changes));
        for (const change of item.changes.slice(0, listLimit)) {
          requireProgress(
            isRecord(change) &&
              typeof change.path === "string" &&
              isStatus(change.kind, ["add", "delete", "update"]),
          );
        }
        truncated ||= item.changes.length > listLimit;
        projected = {
          ...identity,
          status: item.status,
          changes: item.changes.slice(0, listLimit).map((change) => ({
            path: boundedText(change.path),
            kind: change.kind,
          })),
        };
        break;
      case "web_search":
        projected = { ...identity, query: boundedText(item.query) };
        break;
      case "todo_list":
        requireProgress(Array.isArray(item.items));
        for (const entry of item.items.slice(0, listLimit)) {
          requireProgress(
            isRecord(entry) &&
              typeof entry.text === "string" &&
              typeof entry.completed === "boolean",
          );
        }
        truncated ||= item.items.length > listLimit;
        projected = {
          ...identity,
          items: item.items.slice(0, listLimit).map((entry) => ({
            text: boundedText(entry.text),
            completed: entry.completed,
          })),
        };
        break;
      case "error":
        projected = {
          ...identity,
          code: "CODEX_ITEM_ERROR",
          message: "Codex reported a nonfatal diagnostic.",
        };
        break;
      default: {
        const _exhaustive: never = item;
        throw new CodexAdapterError(
          "INVALID_SDK_EVENT",
          "Codex returned an unknown item.",
        );
      }
    }
    let value = { version: 1, phase, item: projected, truncated };
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > cap) {
      value = { version: 1, phase, item: { type: item.type }, truncated: true };
    }
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > cap) {
      throw new CodexAdapterError(
        "PROGRESS_LIMIT",
        "The progress limit is too small for event metadata.",
      );
    }
    return { type: EventType.CUSTOM, name: "codex.item", value };
  }
}

function requireProgress(valid: boolean): asserts valid {
  if (!valid)
    throw new CodexAdapterError(
      "INVALID_SDK_EVENT",
      "Codex returned invalid progress fields.",
    );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStatus(value: unknown, allowed: readonly string[]): boolean {
  return typeof value === "string" && allowed.includes(value);
}

function clip(value: string, maxBytes: number): string {
  let result = value.slice(0, maxBytes);
  while (Buffer.byteLength(result, "utf8") > maxBytes)
    result = result.slice(0, Math.max(0, result.length - 1));
  return result;
}

function fingerprint(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function mapUsage(usage: Usage): TokenUsage {
  if (
    !usage ||
    typeof usage.input_tokens !== "number" ||
    typeof usage.output_tokens !== "number"
  ) {
    throw new CodexAdapterError(
      "INVALID_SDK_EVENT",
      "Codex returned invalid token usage.",
    );
  }
  const breakdown = [
    usage.cached_input_tokens,
    usage.cache_write_input_tokens,
    usage.reasoning_output_tokens,
  ];
  if (
    breakdown.some(
      (count) =>
        count !== undefined &&
        (typeof count !== "number" ||
          !Number.isSafeInteger(count) ||
          count < 0),
    )
  ) {
    throw new CodexAdapterError(
      "INVALID_SDK_EVENT",
      "Codex returned invalid token usage.",
    );
  }
  if (
    (usage.cached_input_tokens ?? 0) + (usage.cache_write_input_tokens ?? 0) >
      usage.input_tokens ||
    (usage.reasoning_output_tokens ?? 0) > usage.output_tokens
  ) {
    throw new CodexAdapterError(
      "INVALID_SDK_EVENT",
      "Codex returned inconsistent token usage.",
    );
  }
  const result: TokenUsage = {
    provider: "openai",
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    totalTokens: usage.input_tokens + usage.output_tokens,
    cachedInputTokens: usage.cached_input_tokens,
    cacheWriteInputTokens: usage.cache_write_input_tokens,
    reasoningTokens: usage.reasoning_output_tokens,
  };
  for (const value of Object.values(result)) {
    if (
      typeof value === "number" &&
      (!Number.isSafeInteger(value) || value < 0)
    ) {
      throw new CodexAdapterError(
        "INVALID_SDK_EVENT",
        "Codex returned invalid token usage.",
      );
    }
  }
  return result;
}

import {
  EventType,
  PROTOCOL_VERSION,
  type Event,
  type Message,
} from "@ag-ui/core";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type {
  AssistantMessage,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { committedCalls, publicText } from "./messages.js";

export interface TranslatorOptions {
  threadId: string;
  runId: string;
  completion: "caller" | "session";
  messageId?: (message: AssistantMessage | ToolResultMessage) => string;
  getMessages?: () => Message[];
}

export interface Translator {
  start(): Event[];
  translate(event: AgentEvent | AgentSessionEvent): Event[];
  finish(): Event[];
  error(publicMessage: string): Event[];
}

interface AssistantTurn {
  id: string;
  textOpen: boolean;
  sentChars: Map<number, number>;
}

export function createTranslator(options: TranslatorOptions): Translator {
  const { threadId, runId } = options;
  let phase: "idle" | "running" | "closed" = "idle";
  let turn: AssistantTurn | undefined;
  let sessionFailure: string | undefined;
  let sequence = 0;
  const messageId =
    options.messageId ?? (() => `${runId}:message:${++sequence}`);
  const pendingResults = new Set<string>();

  function appendText(
    out: Event[],
    current: AssistantTurn,
    index: number,
    delta: string,
  ) {
    if (!delta) return;
    if (!current.textOpen) {
      current.textOpen = true;
      out.push({
        type: EventType.TEXT_MESSAGE_START,
        messageId: current.id,
        role: "assistant",
      });
    }
    current.sentChars.set(
      index,
      (current.sentChars.get(index) ?? 0) + delta.length,
    );
    out.push({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: current.id,
      delta,
    });
  }

  function closeText(out: Event[]) {
    if (turn?.textOpen) {
      out.push({ type: EventType.TEXT_MESSAGE_END, messageId: turn.id });
      turn.textOpen = false;
    }
  }

  function terminate(publicError?: string): Event[] {
    if (phase !== "running") return [];
    const messages =
      publicError === undefined ? options.getMessages?.() : undefined;
    const out: Event[] = [];
    closeText(out);
    if (messages) out.push({ type: EventType.MESSAGES_SNAPSHOT, messages });
    out.push(
      publicError === undefined
        ? { type: EventType.RUN_FINISHED, threadId, runId }
        : { type: EventType.RUN_ERROR, message: publicError },
    );
    phase = "closed";
    turn = undefined;
    pendingResults.clear();
    return out;
  }

  return {
    start() {
      if (phase !== "idle") return [];
      phase = "running";
      return [
        {
          type: EventType.RUN_STARTED,
          threadId,
          runId,
          protocolVersion: PROTOCOL_VERSION,
        },
      ];
    },
    translate(event) {
      if (phase !== "running") return [];
      const out: Event[] = [];
      switch (event.type) {
        case "message_start":
          if (event.message.role === "assistant") {
            turn = {
              id: messageId(event.message),
              textOpen: false,
              sentChars: new Map(),
            };
            sessionFailure = undefined;
          }
          break;
        case "message_update": {
          if (!turn) break;
          const inner = event.assistantMessageEvent;
          if (inner.type === "text_delta") {
            appendText(out, turn, inner.contentIndex, inner.delta);
          } else if (inner.type === "text_end") {
            const rest = inner.content.slice(
              turn.sentChars.get(inner.contentIndex) ?? 0,
            );
            appendText(out, turn, inner.contentIndex, rest);
          }
          break;
        }
        case "message_end": {
          const message = event.message;
          if (
            message.role === "toolResult" &&
            pendingResults.delete(message.toolCallId)
          ) {
            out.push({
              type: EventType.TOOL_CALL_RESULT,
              messageId: messageId(message),
              toolCallId: message.toolCallId,
              content: publicText(message.content),
              role: "tool",
            });
          } else if (message.role === "assistant" && turn) {
            for (const [index, part] of message.content.entries()) {
              if (part.type === "text") {
                appendText(
                  out,
                  turn,
                  index,
                  part.text.slice(turn.sentChars.get(index) ?? 0),
                );
              }
            }
            closeText(out);
            for (const call of committedCalls(message)) {
              if (pendingResults.has(call.id)) continue;
              pendingResults.add(call.id);
              out.push(
                {
                  type: EventType.TOOL_CALL_START,
                  parentMessageId: turn.id,
                  toolCallId: call.id,
                  toolCallName: call.function.name,
                },
                {
                  type: EventType.TOOL_CALL_ARGS,
                  toolCallId: call.id,
                  delta: call.function.arguments,
                },
                { type: EventType.TOOL_CALL_END, toolCallId: call.id },
              );
            }
            turn = undefined;
            if (message.stopReason === "error")
              sessionFailure = "Pi model request failed";
            if (message.stopReason === "aborted")
              sessionFailure = "Pi run aborted";
          }
          break;
        }
        case "agent_settled":
          if (options.completion === "session") {
            return terminate(event.aborted ? "Pi run aborted" : sessionFailure);
          }
          break;
      }
      return out;
    },
    finish: () => terminate(),
    error: terminate,
  };
}

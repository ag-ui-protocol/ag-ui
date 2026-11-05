import { type StreamTextResult } from "ai";
import {
  EventType,
  PROTOCOL_VERSION,
  randomUUID,
  type RunStartedEvent,
  type RunFinishedEvent,
  type RunErrorEvent,
  type TextMessageStartEvent,
  type TextMessageContentEvent,
  type TextMessageEndEvent,
  type ToolCallStartEvent,
  type ToolCallArgsEvent,
  type ToolCallEndEvent,
  type ToolCallResultEvent,
  type MessagesSnapshotEvent,
  type StateSnapshotEvent,
  type BaseEvent,
  type Message,
  type AssistantMessage,
  type ReasoningStartEvent,
  type ReasoningMessageStartEvent,
  type ReasoningMessageContentEvent,
  type ReasoningMessageEndEvent,
  type ReasoningEndEvent,
  type StepStartedEvent,
  type StepFinishedEvent,
  type RawEvent,
  type CustomEvent,
} from "@ag-ui/client";

export class AgentsToAGUIAdapter {
  // StreamTextResult generics are complex and caller-specific — any is intentional
  async *adaptStreamToAGUI(
    stream: StreamTextResult<any, any>,
    threadId: string = randomUUID(),
    runId: string = randomUUID(),
    inputMessages: Message[] = [],
    parentRunId?: string,
    state?: Record<string, unknown>,
    forwardedProps?: Record<string, unknown>,
  ): AsyncGenerator<BaseEvent> {
    let messageId = randomUUID();
    let messageStarted = false;
    let reasoningMessageId: string | null = null;
    let stepCounter = 0;
    // Parent message of each call streamed via tool-input-*, fixed at its START.
    const streamedToolCallParents = new Map<string, string>();
    // The run's output for MESSAGES_SNAPSHOT, in stream order: one assistant
    // message per text message (carrying the calls made from it) and the tool
    // results between them. A multi-step run has several of each.
    const outputMessages: Message[] = [];
    const assistantMessage = (id: string) => {
      let message = outputMessages.find((m) => m.id === id && m.role === "assistant") as AssistantMessage | undefined;
      if (!message) {
        message = { id, role: "assistant" };
        outputMessages.push(message);
      }
      return message;
    };
    const recordToolCall = (parentId: string, id: string, name: string, input: unknown) => {
      const message = assistantMessage(parentId);
      (message.toolCalls ??= []).push({ id, type: "function", function: { name, arguments: JSON.stringify(input) } });
    };

    try {
      const runStarted: RunStartedEvent = {
        type: EventType.RUN_STARTED,
        threadId,
        runId,
        protocolVersion: PROTOCOL_VERSION,
        timestamp: Date.now(),
        ...(parentRunId && { parentRunId }),
        input: {
          threadId,
          runId,
          messages: inputMessages,
          state: state ?? {},
          tools: [],
          context: [],
          forwardedProps: forwardedProps ?? {},
          ...(parentRunId && { parentRunId }),
        },
      };
      yield runStarted;

      if (state && Object.keys(state).length > 0) {
        yield {
          type: EventType.STATE_SNAPSHOT,
          snapshot: state,
          timestamp: Date.now(),
        } as StateSnapshotEvent;
      }

      for await (const part of stream.fullStream) {
        switch (part.type) {
          case "text-delta": {
            if (!messageStarted) {
              messageId = randomUUID();
              yield {
                type: EventType.TEXT_MESSAGE_START,
                messageId,
                role: "assistant",
                timestamp: Date.now(),
              } as TextMessageStartEvent;
              messageStarted = true;
            }
            const message = assistantMessage(messageId);
            message.content = (message.content ?? "") + part.text;
            yield {
              type: EventType.TEXT_MESSAGE_CONTENT,
              messageId,
              delta: part.text,
              timestamp: Date.now(),
            } as TextMessageContentEvent;
            break;
          }

          case "reasoning-start": {
            reasoningMessageId = randomUUID();
            yield { type: EventType.REASONING_START, messageId: reasoningMessageId, timestamp: Date.now() } as ReasoningStartEvent;
            yield { type: EventType.REASONING_MESSAGE_START, messageId: reasoningMessageId, role: "reasoning" as const, timestamp: Date.now() } as ReasoningMessageStartEvent;
            break;
          }

          case "reasoning-delta": {
            if (reasoningMessageId) {
              yield { type: EventType.REASONING_MESSAGE_CONTENT, messageId: reasoningMessageId, delta: part.text, timestamp: Date.now() } as ReasoningMessageContentEvent;
            }
            break;
          }

          case "reasoning-end": {
            if (reasoningMessageId) {
              yield { type: EventType.REASONING_MESSAGE_END, messageId: reasoningMessageId, timestamp: Date.now() } as ReasoningMessageEndEvent;
              yield { type: EventType.REASONING_END, messageId: reasoningMessageId, timestamp: Date.now() } as ReasoningEndEvent;
              reasoningMessageId = null;
            }
            break;
          }

          case "start-step": {
            yield { type: EventType.STEP_STARTED, stepName: `step-${++stepCounter}`, timestamp: Date.now() } as StepStartedEvent;
            break;
          }

          case "finish-step": {
            yield { type: EventType.STEP_FINISHED, stepName: `step-${stepCounter}`, timestamp: Date.now() } as StepFinishedEvent;
            break;
          }

          case "tool-input-start": {
            if (messageStarted) {
              yield { type: EventType.TEXT_MESSAGE_END, messageId, timestamp: Date.now() } as TextMessageEndEvent;
              messageStarted = false;
            }
            streamedToolCallParents.set(part.id, messageId);
            yield { type: EventType.TOOL_CALL_START, toolCallId: part.id, toolCallName: part.toolName, parentMessageId: messageId, timestamp: Date.now() } as ToolCallStartEvent;
            break;
          }

          case "tool-input-delta": {
            yield { type: EventType.TOOL_CALL_ARGS, toolCallId: part.id, delta: part.delta, timestamp: Date.now() } as ToolCallArgsEvent;
            break;
          }

          case "tool-input-end": {
            yield { type: EventType.TOOL_CALL_END, toolCallId: part.id, timestamp: Date.now() } as ToolCallEndEvent;
            break;
          }

          case "tool-call": {
            const streamedParent = streamedToolCallParents.get(part.toolCallId);
            if (streamedParent !== undefined) {
              // Already emitted via tool-input-* streaming — just track for MESSAGES_SNAPSHOT
              recordToolCall(streamedParent, part.toolCallId, part.toolName, part.input);
              break;
            }
            if (messageStarted) {
              yield { type: EventType.TEXT_MESSAGE_END, messageId, timestamp: Date.now() } as TextMessageEndEvent;
              messageStarted = false;
            }
            yield { type: EventType.TOOL_CALL_START, toolCallId: part.toolCallId, toolCallName: part.toolName, parentMessageId: messageId, timestamp: Date.now() } as ToolCallStartEvent;
            yield { type: EventType.TOOL_CALL_ARGS, toolCallId: part.toolCallId, delta: JSON.stringify(part.input), timestamp: Date.now() } as ToolCallArgsEvent;
            yield { type: EventType.TOOL_CALL_END, toolCallId: part.toolCallId, timestamp: Date.now() } as ToolCallEndEvent;
            recordToolCall(messageId, part.toolCallId, part.toolName, part.input);
            break;
          }

          case "tool-result": {
            const toolMsgId = randomUUID();
            yield { type: EventType.TOOL_CALL_RESULT, toolCallId: part.toolCallId, content: JSON.stringify(part.output), messageId: toolMsgId, role: "tool", timestamp: Date.now() } as ToolCallResultEvent;
            outputMessages.push({
              id: toolMsgId,
              role: "tool",
              toolCallId: part.toolCallId,
              content: JSON.stringify(part.output),
            });
            break;
          }

          case "tool-error": {
            const errorContent = JSON.stringify({ error: part.error instanceof Error ? part.error.message : String(part.error) });
            const toolMsgId = randomUUID();
            yield {
              type: EventType.TOOL_CALL_RESULT,
              toolCallId: part.toolCallId,
              content: errorContent,
              messageId: toolMsgId,
              role: "tool",
              timestamp: Date.now(),
            } as ToolCallResultEvent;
            outputMessages.push({
              id: toolMsgId,
              role: "tool",
              toolCallId: part.toolCallId,
              content: errorContent,
            });
            break;
          }

          case "source": {
            yield {
              type: EventType.CUSTOM,
              name: "source",
              value: part.sourceType === "url"
                ? { sourceType: part.sourceType, id: part.id, url: part.url, title: part.title }
                : { sourceType: part.sourceType, id: part.id, mediaType: part.mediaType, title: part.title },
              timestamp: Date.now(),
            } as CustomEvent;
            break;
          }

          case "file": {
            yield {
              type: EventType.CUSTOM,
              name: "file",
              value: part.file,
              timestamp: Date.now(),
            } as CustomEvent;
            break;
          }

          case "raw": {
            yield { type: EventType.RAW, event: part.rawValue, source: "ai-sdk", timestamp: Date.now() } as RawEvent;
            break;
          }

          case "abort": {
            if (messageStarted) {
              yield { type: EventType.TEXT_MESSAGE_END, messageId, timestamp: Date.now() } as TextMessageEndEvent;
              messageStarted = false;
            }
            if (reasoningMessageId) {
              yield { type: EventType.REASONING_MESSAGE_END, messageId: reasoningMessageId, timestamp: Date.now() } as ReasoningMessageEndEvent;
              yield { type: EventType.REASONING_END, messageId: reasoningMessageId, timestamp: Date.now() } as ReasoningEndEvent;
              reasoningMessageId = null;
            }
            yield { type: EventType.RUN_ERROR, message: "Stream aborted", code: "ABORTED", timestamp: Date.now() } as RunErrorEvent;
            return;
          }

          case "error": {
            if (messageStarted) {
              yield { type: EventType.TEXT_MESSAGE_END, messageId, timestamp: Date.now() } as TextMessageEndEvent;
              messageStarted = false;
            }
            yield {
              type: EventType.RUN_ERROR,
              message: part.error instanceof Error ? part.error.message : String(part.error),
              code: "STREAM_ERROR",
              timestamp: Date.now(),
            } as RunErrorEvent;
            return;
          }

          case "finish": {
            if (messageStarted) {
              yield { type: EventType.TEXT_MESSAGE_END, messageId, timestamp: Date.now() } as TextMessageEndEvent;
              messageStarted = false;
            }
            break;
          }
        }
      }

      if (messageStarted) {
        yield { type: EventType.TEXT_MESSAGE_END, messageId, timestamp: Date.now() } as TextMessageEndEvent;
      }

      if (reasoningMessageId) {
        yield { type: EventType.REASONING_MESSAGE_END, messageId: reasoningMessageId, timestamp: Date.now() } as ReasoningMessageEndEvent;
        yield { type: EventType.REASONING_END, messageId: reasoningMessageId, timestamp: Date.now() } as ReasoningEndEvent;
        reasoningMessageId = null;
      }

      if (!outputMessages.some((m) => m.role === "assistant")) {
        outputMessages.unshift({ id: messageId, role: "assistant", content: (await stream.text) || undefined });
      }
      yield {
        type: EventType.MESSAGES_SNAPSHOT,
        messages: [...inputMessages, ...outputMessages],
        timestamp: Date.now(),
      } as MessagesSnapshotEvent;
      yield { type: EventType.RUN_FINISHED, threadId, runId, timestamp: Date.now(), outcome: { type: "success" } } as RunFinishedEvent;
    } catch (error) {
      if (messageStarted) {
        yield { type: EventType.TEXT_MESSAGE_END, messageId, timestamp: Date.now() } as TextMessageEndEvent;
      }
      if (reasoningMessageId) {
        yield { type: EventType.REASONING_MESSAGE_END, messageId: reasoningMessageId, timestamp: Date.now() } as ReasoningMessageEndEvent;
        yield { type: EventType.REASONING_END, messageId: reasoningMessageId, timestamp: Date.now() } as ReasoningEndEvent;
      }
      yield { type: EventType.RUN_ERROR, message: error instanceof Error ? error.message : String(error), code: "STREAM_ERROR", timestamp: Date.now() } as RunErrorEvent;
    }
  }
}

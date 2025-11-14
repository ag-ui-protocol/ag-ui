/**
 * Adapter for converting Vercel AI SDK streams to AG-UI protocol events
 *
 * Bridges Vercel AI SDK streaming API and AG-UI event protocol,
 * enabling Cloudflare Agents to communicate with AG-UI clients.
 */

import { type StreamTextResult } from "ai";
import {
  EventType,
  type RunStartedEvent,
  type RunFinishedEvent,
  type RunErrorEvent,
  type TextMessageChunkEvent,
  type ToolCallStartEvent,
  type ToolCallArgsEvent,
  type ToolCallEndEvent,
  type ToolCallResultEvent,
  type MessagesSnapshotEvent,
  type BaseEvent,
  type Message,
} from "@ag-ui/client";
import { nanoid } from "nanoid";

/**
 * Adapts Vercel AI SDK streaming responses to AG-UI events
 */
export class AgentsToAGUIAdapter {
  /**
   * Convert AI SDK stream to AG-UI event stream
   *
   * @param stream - StreamTextResult from Vercel AI SDK
   * @param threadId - Thread ID for conversation tracking
   * @param runId - Run ID for execution tracking
   * @param inputMessages - Original input messages for snapshot
   * @returns AsyncGenerator yielding AG-UI events
   */
  async *adaptStreamToAGUI(
    stream: StreamTextResult<any, any>,
    threadId: string = nanoid(),
    runId: string = nanoid(),
    inputMessages: Message[] = []
  ): AsyncGenerator<BaseEvent> {
    const messageId = nanoid();

    try {
      const runStarted: RunStartedEvent = {
        type: EventType.RUN_STARTED,
        threadId,
        runId,
        timestamp: Date.now(),
      };
      yield runStarted;

      for await (const chunk of stream.textStream) {
        const textChunk: TextMessageChunkEvent = {
          type: EventType.TEXT_MESSAGE_CHUNK,
          messageId,
          role: "assistant",
          delta: chunk,
          timestamp: Date.now(),
        };
        yield textChunk;
      }

      const response = await stream;
      const toolCalls = await response.toolCalls;
      const toolResults = await response.toolResults;
      const finalText = await response.text;

      if (toolCalls && toolCalls.length > 0) {
        for (const toolCall of toolCalls) {
          const toolStart: ToolCallStartEvent = {
            type: EventType.TOOL_CALL_START,
            toolCallId: toolCall.toolCallId,
            toolCallName: toolCall.toolName,
            parentMessageId: messageId,
            timestamp: Date.now(),
          };
          yield toolStart;

          const toolArgs: ToolCallArgsEvent = {
            type: EventType.TOOL_CALL_ARGS,
            toolCallId: toolCall.toolCallId,
            delta: JSON.stringify(
              "input" in toolCall ? toolCall.input : (toolCall as any).args
            ),
            timestamp: Date.now(),
          };
          yield toolArgs;

          const toolEnd: ToolCallEndEvent = {
            type: EventType.TOOL_CALL_END,
            toolCallId: toolCall.toolCallId,
            timestamp: Date.now(),
          };
          yield toolEnd;
        }
      }

      if (toolResults && toolResults.length > 0) {
        for (const toolResult of toolResults) {
          const resultEvent: ToolCallResultEvent = {
            type: EventType.TOOL_CALL_RESULT,
            messageId: nanoid(),
            toolCallId: toolResult.toolCallId,
            content: JSON.stringify(
              "result" in toolResult
                ? toolResult.result
                : (toolResult as any).output
            ),
            role: "tool",
            timestamp: Date.now(),
          };
          yield resultEvent;
        }
      }

      const messagesSnapshot: MessagesSnapshotEvent = {
        type: EventType.MESSAGES_SNAPSHOT,
        messages: [
          ...inputMessages,
          {
            id: messageId,
            role: "assistant",
            content: finalText,
          },
        ],
        timestamp: Date.now(),
      };
      yield messagesSnapshot;

      const runFinished: RunFinishedEvent = {
        type: EventType.RUN_FINISHED,
        threadId,
        runId,
        timestamp: Date.now(),
      };
      yield runFinished;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      const runError: RunErrorEvent = {
        type: EventType.RUN_ERROR,
        message: errorMessage,
        code: "STREAM_ERROR",
        timestamp: Date.now(),
      };
      yield runError;
    }
  }
}

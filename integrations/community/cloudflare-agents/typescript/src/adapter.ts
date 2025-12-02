/**
 * Adapter for converting Vercel AI SDK streams to AG-UI protocol events
 */

import { type StreamTextResult } from "ai";
import {
  EventType,
  type RunStartedEvent,
  type RunFinishedEvent,
  type RunErrorEvent,
  type TextMessageChunkEvent,
  type ToolCallChunkEvent,
  type ToolCallResultEvent,
  type MessagesSnapshotEvent,
  type StateSnapshotEvent,
  type StepStartedEvent,
  type StepFinishedEvent,
  type BaseEvent,
  type Message,
} from "@ag-ui/client";
import { nanoid } from "nanoid";

export class AgentsToAGUIAdapter {
  /**
   * Convert AI SDK stream to AG-UI event stream
   *
   * @param stream - StreamTextResult from Vercel AI SDK
   * @param threadId - Thread ID for conversation tracking
   * @param runId - Run ID for execution tracking
   * @param inputMessages - Original input messages for snapshot
   * @param parentRunId - Optional parent run ID for branching/time travel
   * @param state - Optional agent state
   * @returns AsyncGenerator yielding AG-UI events
   */
  async *adaptStreamToAGUI(
    stream: StreamTextResult<any, any>,
    threadId: string = nanoid(),
    runId: string = nanoid(),
    inputMessages: Message[] = [],
    parentRunId?: string,
    state?: any
  ): AsyncGenerator<BaseEvent> {
    const messageId = nanoid();

    try {
      const runStarted: RunStartedEvent = {
        type: EventType.RUN_STARTED,
        threadId,
        runId,
        timestamp: Date.now(),
        ...(parentRunId && { parentRunId }),
        input: {
          threadId,
          runId,
          messages: inputMessages,
          state: state || {},
          tools: [],
          context: [],
          ...(parentRunId && { parentRunId }),
        },
      };
      yield runStarted;

      if (state && Object.keys(state).length > 0) {
        const stateSnapshot: StateSnapshotEvent = {
          type: EventType.STATE_SNAPSHOT,
          snapshot: state,
          timestamp: Date.now(),
        };
        yield stateSnapshot;
      }

      const textGenerationStep: StepStartedEvent = {
        type: EventType.STEP_STARTED,
        stepName: "Generating Response",
        timestamp: Date.now(),
      };
      yield textGenerationStep;

      let isFirstChunk = true;
      for await (const chunk of stream.textStream) {
        const textChunk: TextMessageChunkEvent = {
          type: EventType.TEXT_MESSAGE_CHUNK,
          delta: chunk,
          timestamp: Date.now(),
          ...(isFirstChunk && { messageId, role: "assistant" }),
        };
        yield textChunk;
        isFirstChunk = false;
      }

      const textGenerationStepEnd: StepFinishedEvent = {
        type: EventType.STEP_FINISHED,
        stepName: "Generating Response",
        timestamp: Date.now(),
      };
      yield textGenerationStepEnd;

      const response = await stream;
      const toolCalls = await response.toolCalls;
      const toolResults = await response.toolResults;
      const finalText = await response.text;

      if (toolCalls && toolCalls.length > 0) {
        const toolExecutionStep: StepStartedEvent = {
          type: EventType.STEP_STARTED,
          stepName: "Executing Tools",
          timestamp: Date.now(),
        };
        yield toolExecutionStep;

        for (const toolCall of toolCalls) {
          const toolCallChunk: ToolCallChunkEvent = {
            type: EventType.TOOL_CALL_CHUNK,
            toolCallId: toolCall.toolCallId,
            toolCallName: toolCall.toolName,
            parentMessageId: messageId,
            delta: JSON.stringify(
              "input" in toolCall ? toolCall.input : (toolCall as any).args
            ),
            timestamp: Date.now(),
          };
          yield toolCallChunk;
        }

        const toolExecutionStepEnd: StepFinishedEvent = {
          type: EventType.STEP_FINISHED,
          stepName: "Executing Tools",
          timestamp: Date.now(),
        };
        yield toolExecutionStepEnd;
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
        result: {
          text: finalText,
          messageId,
          toolCallsCount: toolCalls?.length || 0,
          toolResultsCount: toolResults?.length || 0,
        },
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

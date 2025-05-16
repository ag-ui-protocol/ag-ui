import {
  ApplyEvents,
  EventType,
  TextMessageStartEvent,
  TextMessageContentEvent,
  Message,
  ToolCallStartEvent,
  ToolCallArgsEvent,
  StateSnapshotEvent,
  StateDeltaEvent,
  MessagesSnapshotEvent,
  CustomEvent,
  BaseEvent,
  AssistantMessage,
} from "@ag-ui/core";
import { mergeMap } from "rxjs/operators";
import { structuredClone_ } from "../utils";
import { applyPatch } from "fast-json-patch";
import untruncateJson from "untruncate-json";
import { AgentState } from "@ag-ui/core";
import { Observable } from "rxjs";

interface PredictStateValue {
  state_key: string;
  tool: string;
  tool_argument: string;
}

export const defaultApplyEvents = (...args: Parameters<ApplyEvents>): ReturnType<ApplyEvents> => {
  const [input, events$] = args;

  let messages = structuredClone_(input.messages);
  let state = structuredClone_(input.state);
  let predictState: PredictStateValue[] | undefined;

  // Helper function to emit state updates with proper cloning
  const emitUpdate = (agentState: AgentState) => [structuredClone_(agentState)];

  const emitNoUpdate = () => [];

  return events$.pipe(
    mergeMap((event) => {
      switch (event.type) {
        case EventType.TEXT_MESSAGE_START: {
          const { messageId, role } = event as TextMessageStartEvent;

          // Create a new message using properties from the event
          const newMessage: Message = {
            id: messageId,
            role: role,
            content: "",
          };

          // Add the new message to the messages array
          messages.push(newMessage);

          return emitUpdate({ messages });
        }

        case EventType.TEXT_MESSAGE_CONTENT: {
          const { delta } = event as TextMessageContentEvent;

          // Get the last message and append the content
          const lastMessage = messages[messages.length - 1];
          lastMessage.content = lastMessage.content! + delta;

          return emitUpdate({ messages });
        }

        case EventType.TEXT_MESSAGE_END: {
          return emitNoUpdate();
        }

        case EventType.TOOL_CALL_START: {
          const { toolCallId, toolCallName, parentMessageId } = event as ToolCallStartEvent;

          let targetMessage: AssistantMessage;

          // Use last message if parentMessageId exists, we have messages, and the parentMessageId matches the last message's id
          if (
            parentMessageId &&
            messages.length > 0 &&
            messages[messages.length - 1].id === parentMessageId
          ) {
            targetMessage = messages[messages.length - 1];
          } else {
            // Create a new message otherwise
            targetMessage = {
              id: parentMessageId || toolCallId,
              role: "assistant",
              toolCalls: [],
            };
            messages.push(targetMessage);
          }

          targetMessage.toolCalls ??= [];

          // Add the new tool call
          targetMessage.toolCalls.push({
            id: toolCallId,
            type: "function",
            function: {
              name: toolCallName,
              arguments: "",
            },
          });

          return emitUpdate({ messages });
        }

        case EventType.TOOL_CALL_ARGS: {
          const { delta } = event as ToolCallArgsEvent;

          // Get the last message
          const lastMessage = messages[messages.length - 1];

          // Get the last tool call
          const lastToolCall = lastMessage.toolCalls[lastMessage.toolCalls.length - 1];

          // Append the arguments
          lastToolCall.function.arguments += delta;

          if (predictState) {
            const config = predictState.find((p) => p.tool === lastToolCall.function.name);
            if (config) {
              try {
                const lastToolCallArguments = JSON.parse(
                  untruncateJson(lastToolCall.function.arguments),
                );
                if (config.tool_argument && config.tool_argument in lastToolCallArguments) {
                  state = {
                    ...state,
                    [config.state_key]: lastToolCallArguments[config.tool_argument],
                  };
                  return emitUpdate({ messages, state });
                } else {
                  state = {
                    ...state,
                    [config.state_key]: lastToolCallArguments,
                  };
                  return emitUpdate({ messages, state });
                }
              } catch (_) {}
            }
          }

          return emitUpdate({ messages });
        }

        case EventType.TOOL_CALL_END: {
          return emitNoUpdate();
        }

        case EventType.STATE_SNAPSHOT: {
          const { snapshot } = event as StateSnapshotEvent;

          // Replace state with the literal snapshot
          state = snapshot;

          return emitUpdate({ state });
        }

        case EventType.STATE_DELTA: {
          const { delta } = event as StateDeltaEvent;

          try {
            // Apply the JSON Patch operations to the current state without mutating the original
            const result = applyPatch(state, delta, true, false);
            state = result.newDocument;
            return emitUpdate({ state });
          } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.warn(
              `Failed to apply state patch:\n` +
                `Current state: ${JSON.stringify(state, null, 2)}\n` +
                `Patch operations: ${JSON.stringify(delta, null, 2)}\n` +
                `Error: ${errorMessage}`,
            );
            return emitNoUpdate();
          }
        }

        case EventType.MESSAGES_SNAPSHOT: {
          const { messages: newMessages } = event as MessagesSnapshotEvent;

          // Replace messages with the snapshot
          messages = newMessages;

          return emitUpdate({ messages });
        }

        case EventType.RAW: {
          return emitNoUpdate();
        }

        case EventType.CUSTOM: {
          const customEvent = event as CustomEvent;

          if (customEvent.name === "PredictState") {
            predictState = customEvent.value as PredictStateValue[];
            return emitNoUpdate();
          }

          return emitNoUpdate();
        }

        case EventType.RUN_STARTED: {
          return emitNoUpdate();
        }

        case EventType.RUN_FINISHED: {
          return emitNoUpdate();
        }

        case EventType.RUN_ERROR: {
          return emitNoUpdate();
        }

        case EventType.STEP_STARTED: {
          return emitNoUpdate();
        }

        case EventType.STEP_FINISHED: {
          // reset predictive state after step is finished
          predictState = undefined;
          return emitNoUpdate();
        }

        case EventType.TEXT_MESSAGE_CHUNK: {
          throw new Error("TEXT_MESSAGE_CHUNK must be tranformed before being applied");
        }

        case EventType.TOOL_CALL_CHUNK: {
          throw new Error("TOOL_CALL_CHUNK must be tranformed before being applied");
        }
      }

      // This makes TypeScript check that the switch is exhaustive
      // If a new EventType is added, this will cause a compile error
      const _exhaustiveCheck: never = event.type;
      return emitNoUpdate();
    }),
  );
};

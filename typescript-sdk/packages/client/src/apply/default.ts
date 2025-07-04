import {
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
  ToolCallResultEvent,
  ToolMessage,
  RunAgentInput,
  TextMessageEndEvent,
  ToolCallEndEvent,
  RawEvent,
  RunStartedEvent,
  RunFinishedEvent,
  RunErrorEvent,
  StepStartedEvent,
  StepFinishedEvent,
} from "@ag-ui/core";
import { mergeMap, mergeAll } from "rxjs/operators";
import { of, EMPTY } from "rxjs";
import { structuredClone_ } from "../utils";
import { applyPatch } from "fast-json-patch";
import {
  AgentStateMutation,
  RunAgentSubscriber,
  runSubscribersWithMutation,
} from "@/agent/subscriber";
import { Observable } from "rxjs";
import { AbstractAgent } from "@/agent/agent";
import untruncateJson from "untruncate-json";

export const defaultApplyEvents = (
  input: RunAgentInput,
  events$: Observable<BaseEvent>,
  agent: AbstractAgent,
  subscribers: RunAgentSubscriber[],
): Observable<AgentStateMutation> => {
  let messages = structuredClone_(input.messages);
  let state = structuredClone_(input.state);
  let currentMutation: AgentStateMutation = {};

  const applyMutation = (mutation: AgentStateMutation) => {
    if (mutation.messages !== undefined) {
      messages = mutation.messages;
      currentMutation.messages = mutation.messages;
    }
    if (mutation.state !== undefined) {
      state = mutation.state;
      currentMutation.state = mutation.state;
    }
  };

  const emitUpdates = () => {
    const result = structuredClone_(currentMutation) as AgentStateMutation;
    currentMutation = {};
    if (result.messages !== undefined || result.state !== undefined) {
      return of(result);
    }
    return EMPTY;
  };

  return events$.pipe(
    mergeMap(async (event) => {
      switch (event.type) {
        case EventType.TEXT_MESSAGE_START: {
          const mutation = await runSubscribersWithMutation(
            subscribers,
            messages,
            state,
            (subscriber, messages, state) =>
              subscriber.onTextMessageStartEvent?.({
                event: event as TextMessageStartEvent,
                messages,
                state,
                agent,
                input,
              }),
          );
          applyMutation(mutation);

          if (mutation.stopPropagation !== true) {
            const { messageId, role } = event as TextMessageStartEvent;

            // Create a new message using properties from the event
            const newMessage: Message = {
              id: messageId,
              role: role,
              content: "",
            };

            // Add the new message to the messages array
            messages.push(newMessage);
            applyMutation({ messages });
          }
          return emitUpdates();
        }

        case EventType.TEXT_MESSAGE_CONTENT: {
          const mutation = await runSubscribersWithMutation(
            subscribers,
            messages,
            state,
            (subscriber, messages, state) =>
              subscriber.onTextMessageContentEvent?.({
                event: event as TextMessageContentEvent,
                messages,
                state,
                agent,
                input,
                textMessageBuffer: messages[messages.length - 1].content ?? "",
              }),
          );
          applyMutation(mutation);

          if (mutation.stopPropagation !== true) {
            const { delta } = event as TextMessageContentEvent;

            // Get the last message and append the content
            const lastMessage = messages[messages.length - 1];
            lastMessage.content = lastMessage.content! + delta;
            applyMutation({ messages });
          }

          return emitUpdates();
        }

        case EventType.TEXT_MESSAGE_END: {
          const mutation = await runSubscribersWithMutation(
            subscribers,
            messages,
            state,
            (subscriber, messages, state) =>
              subscriber.onTextMessageEndEvent?.({
                event: event as TextMessageEndEvent,
                messages,
                state,
                agent,
                input,
                textMessageBuffer: messages[messages.length - 1].content ?? "",
              }),
          );
          applyMutation(mutation);

          return emitUpdates();
        }

        case EventType.TOOL_CALL_START: {
          const mutation = await runSubscribersWithMutation(
            subscribers,
            messages,
            state,
            (subscriber, messages, state) =>
              subscriber.onToolCallStartEvent?.({
                event: event as ToolCallStartEvent,
                messages,
                state,
                agent,
                input,
              }),
          );
          applyMutation(mutation);

          if (mutation.stopPropagation !== true) {
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

            applyMutation({ messages });
          }

          return emitUpdates();
        }

        case EventType.TOOL_CALL_ARGS: {
          const mutation = await runSubscribersWithMutation(
            subscribers,
            messages,
            state,
            (subscriber, messages, state) => {
              const toolCalls =
                (messages[messages.length - 1] as AssistantMessage)?.toolCalls ?? [];
              const toolCallBuffer =
                toolCalls.length > 0 ? toolCalls[toolCalls.length - 1].function.arguments : "";
              const toolCallName =
                toolCalls.length > 0 ? toolCalls[toolCalls.length - 1].function.name : "";
              let partialToolCallArgs = {};
              try {
                partialToolCallArgs = untruncateJson(
                  toolCallBuffer + (event as ToolCallArgsEvent).delta,
                );
              } catch (error) {}

              return subscriber.onToolCallArgsEvent?.({
                event: event as ToolCallArgsEvent,
                messages,
                state,
                agent,
                input,
                toolCallBuffer,
                toolCallName,
                partialToolCallArgs,
              });
            },
          );
          applyMutation(mutation);

          if (mutation.stopPropagation !== true) {
            const { delta } = event as ToolCallArgsEvent;

            // Get the last message
            const lastMessage = messages[messages.length - 1];

            // Get the last tool call
            const lastToolCall = lastMessage.toolCalls[lastMessage.toolCalls.length - 1];

            // Append the arguments
            lastToolCall.function.arguments += delta;

            applyMutation({ messages });
          }

          return emitUpdates();
        }

        case EventType.TOOL_CALL_END: {
          const mutation = await runSubscribersWithMutation(
            subscribers,
            messages,
            state,
            (subscriber, messages, state) => {
              const toolCalls =
                (messages[messages.length - 1] as AssistantMessage)?.toolCalls ?? [];
              const toolCallArgsString =
                toolCalls.length > 0 ? toolCalls[toolCalls.length - 1].function.arguments : "";
              const toolCallName =
                toolCalls.length > 0 ? toolCalls[toolCalls.length - 1].function.name : "";
              let toolCallArgs = {};
              try {
                toolCallArgs = JSON.parse(toolCallArgsString);
              } catch (error) {}
              return subscriber.onToolCallEndEvent?.({
                event: event as ToolCallEndEvent,
                messages,
                state,
                agent,
                input,
                toolCallName,
                toolCallArgs,
              });
            },
          );
          applyMutation(mutation);

          return emitUpdates();
        }

        case EventType.TOOL_CALL_RESULT: {
          const mutation = await runSubscribersWithMutation(
            subscribers,
            messages,
            state,
            (subscriber, messages, state) =>
              subscriber.onToolCallResultEvent?.({
                event: event as ToolCallResultEvent,
                messages,
                state,
                agent,
                input,
              }),
          );

          applyMutation(mutation);

          if (mutation.stopPropagation !== true) {
            const { messageId, toolCallId, content, role } = event as ToolCallResultEvent;

            const toolMessage: ToolMessage = {
              id: messageId,
              toolCallId,
              role: role || "tool",
              content: content,
            };

            messages.push(toolMessage);

            applyMutation({ messages });
          }

          return emitUpdates();
        }

        case EventType.STATE_SNAPSHOT: {
          const mutation = await runSubscribersWithMutation(
            subscribers,
            messages,
            state,
            (subscriber, messages, state) =>
              subscriber.onStateSnapshotEvent?.({
                event: event as StateSnapshotEvent,
                messages,
                state,
                agent,
                input,
              }),
          );
          applyMutation(mutation);

          if (mutation.stopPropagation !== true) {
            const { snapshot } = event as StateSnapshotEvent;

            // Replace state with the literal snapshot
            state = snapshot;

            applyMutation({ state });
          }

          return emitUpdates();
        }

        case EventType.STATE_DELTA: {
          const mutation = await runSubscribersWithMutation(
            subscribers,
            messages,
            state,
            (subscriber, messages, state) =>
              subscriber.onStateDeltaEvent?.({
                event: event as StateDeltaEvent,
                messages,
                state,
                agent,
                input,
              }),
          );
          applyMutation(mutation);

          if (mutation.stopPropagation !== true) {
            const { delta } = event as StateDeltaEvent;

            try {
              // Apply the JSON Patch operations to the current state without mutating the original
              const result = applyPatch(state, delta, true, false);
              state = result.newDocument;
              applyMutation({ state });
            } catch (error: unknown) {
              const errorMessage = error instanceof Error ? error.message : String(error);
              console.warn(
                `Failed to apply state patch:\n` +
                  `Current state: ${JSON.stringify(state, null, 2)}\n` +
                  `Patch operations: ${JSON.stringify(delta, null, 2)}\n` +
                  `Error: ${errorMessage}`,
              );
            }
          }

          return emitUpdates();
        }

        case EventType.MESSAGES_SNAPSHOT: {
          const mutation = await runSubscribersWithMutation(
            subscribers,
            messages,
            state,
            (subscriber, messages, state) =>
              subscriber.onMessagesSnapshotEvent?.({
                event: event as MessagesSnapshotEvent,
                messages,
                state,
                agent,
                input,
              }),
          );
          applyMutation(mutation);

          if (mutation.stopPropagation !== true) {
            const { messages: newMessages } = event as MessagesSnapshotEvent;

            // Replace messages with the snapshot
            messages = newMessages;

            applyMutation({ messages });
          }

          return emitUpdates();
        }

        case EventType.RAW: {
          const mutation = await runSubscribersWithMutation(
            subscribers,
            messages,
            state,
            (subscriber, messages, state) =>
              subscriber.onRawEvent?.({
                event: event as RawEvent,
                messages,
                state,
                agent,
                input,
              }),
          );
          applyMutation(mutation);

          return emitUpdates();
        }

        case EventType.CUSTOM: {
          const mutation = await runSubscribersWithMutation(
            subscribers,
            messages,
            state,
            (subscriber, messages, state) =>
              subscriber.onCustomEvent?.({
                event: event as CustomEvent,
                messages,
                state,
                agent,
                input,
              }),
          );
          applyMutation(mutation);

          return emitUpdates();
        }

        case EventType.RUN_STARTED: {
          const mutation = await runSubscribersWithMutation(
            subscribers,
            messages,
            state,
            (subscriber, messages, state) =>
              subscriber.onRunStartedEvent?.({
                event: event as RunStartedEvent,
                messages,
                state,
                agent,
                input,
              }),
          );
          applyMutation(mutation);

          return emitUpdates();
        }

        case EventType.RUN_FINISHED: {
          const mutation = await runSubscribersWithMutation(
            subscribers,
            messages,
            state,
            (subscriber, messages, state) =>
              subscriber.onRunFinishedEvent?.({
                event: event as RunFinishedEvent,
                messages,
                state,
                agent,
                input,
                result: (event as RunFinishedEvent).result,
              }),
          );
          applyMutation(mutation);

          return emitUpdates();
        }

        case EventType.RUN_ERROR: {
          const mutation = await runSubscribersWithMutation(
            subscribers,
            messages,
            state,
            (subscriber, messages, state) =>
              subscriber.onRunErrorEvent?.({
                event: event as RunErrorEvent,
                messages,
                state,
                agent,
                input,
              }),
          );
          applyMutation(mutation);

          return emitUpdates();
        }

        case EventType.STEP_STARTED: {
          const mutation = await runSubscribersWithMutation(
            subscribers,
            messages,
            state,
            (subscriber, messages, state) =>
              subscriber.onStepStartedEvent?.({
                event: event as StepStartedEvent,
                messages,
                state,
                agent,
                input,
              }),
          );
          applyMutation(mutation);

          return emitUpdates();
        }

        case EventType.STEP_FINISHED: {
          const mutation = await runSubscribersWithMutation(
            subscribers,
            messages,
            state,
            (subscriber, messages, state) =>
              subscriber.onStepFinishedEvent?.({
                event: event as StepFinishedEvent,
                messages,
                state,
                agent,
                input,
              }),
          );
          applyMutation(mutation);

          return emitUpdates();
        }

        case EventType.TEXT_MESSAGE_CHUNK: {
          throw new Error("TEXT_MESSAGE_CHUNK must be tranformed before being applied");
        }

        case EventType.TOOL_CALL_CHUNK: {
          throw new Error("TOOL_CALL_CHUNK must be tranformed before being applied");
        }

        case EventType.THINKING_START: {
          return emitUpdates();
        }

        case EventType.THINKING_END: {
          return emitUpdates();
        }

        case EventType.THINKING_TEXT_MESSAGE_START: {
          return emitUpdates();
        }

        case EventType.THINKING_TEXT_MESSAGE_CONTENT: {
          return emitUpdates();
        }

        case EventType.THINKING_TEXT_MESSAGE_END: {
          return emitUpdates();
        }
      }

      // This makes TypeScript check that the switch is exhaustive
      // If a new EventType is added, this will cause a compile error
      const _exhaustiveCheck: never = event.type;
      return emitUpdates();
    }),
    mergeAll(),
  );
};

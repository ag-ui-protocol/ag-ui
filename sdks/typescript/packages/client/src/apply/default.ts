import {
  EventType,
  TextMessageStartEvent,
  TextMessageContentEvent,
  Message,
  DeveloperMessage,
  SystemMessage,
  AssistantMessage,
  UserMessage,
  ToolCallStartEvent,
  ToolCallArgsEvent,
  StateSnapshotEvent,
  StateDeltaEvent,
  MessagesSnapshotEvent,
  CustomEvent,
  BaseEvent,
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
  ActivitySnapshotEvent,
  ActivityDeltaEvent,
  ActivityMessage,
} from "@ag-ui/core";
import { mergeMap, mergeAll, defaultIfEmpty, concatMap } from "rxjs/operators";
import { of, EMPTY } from "rxjs";
import { structuredClone_ } from "../utils";
import { applyPatch } from "fast-json-patch";
import {
  AgentStateMutation,
  AgentSubscriber,
  runSubscribersWithMutation,
} from "@/agent/subscriber";
import { Observable } from "rxjs";
import { AbstractAgent } from "@/agent/agent";
import untruncateJson from "untruncate-json";

export const defaultApplyEvents = (
  input: RunAgentInput,
  events$: Observable<BaseEvent>,
  agent: AbstractAgent,
  subscribers: AgentSubscriber[],
): Observable<AgentStateMutation> => {
  let messages = structuredClone_(agent.messages);
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
    concatMap(async (event) => {
      const mutation = await runSubscribersWithMutation(
        subscribers,
        messages,
        state,
        (subscriber, messages, state) =>
          subscriber.onEvent?.({ event, agent, input, messages, state }),
      );
      applyMutation(mutation);

      if (mutation.stopPropagation === true) {
        return emitUpdates();
      }

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
            const { messageId, role = "assistant" } = event as TextMessageStartEvent;

            // Check if a message with this ID already exists (e.g., created by TOOL_CALL_START
            // with the same parentMessageId)
            const existingMessage = messages.find((m) => m.id === messageId);

            if (!existingMessage) {
              // Create a new message using properties from the event
              // Text messages can be developer, system, assistant, or user (not tool)
              const newMessage: Message = {
                id: messageId,
                role: role,
                content: "",
              };

              // Add the new message to the messages array
              messages.push(newMessage);
              applyMutation({ messages });
            }
            // If message already exists, we don't need to create a new one
            // The TEXT_MESSAGE_CONTENT events will update the existing message's content
          }
          return emitUpdates();
        }

        case EventType.TEXT_MESSAGE_CONTENT: {
          const { messageId, delta } = event as TextMessageContentEvent;

          // Find the target message by ID
          const targetMessage = messages.find((m) => m.id === messageId);
          if (!targetMessage) {
            console.warn(`TEXT_MESSAGE_CONTENT: No message found with ID '${messageId}'`);
            return emitUpdates();
          }

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
                textMessageBuffer:
                  typeof targetMessage.content === "string" ? targetMessage.content : "",
              }),
          );
          applyMutation(mutation);

          if (mutation.stopPropagation !== true) {
            // Append content to the correct message by ID
            const existingContent =
              typeof targetMessage.content === "string" ? targetMessage.content : "";
            targetMessage.content = `${existingContent}${delta}`;
            applyMutation({ messages });
          }

          return emitUpdates();
        }

        case EventType.TEXT_MESSAGE_END: {
          const { messageId } = event as TextMessageEndEvent;

          // Find the target message by ID
          const targetMessage = messages.find((m) => m.id === messageId);
          if (!targetMessage) {
            console.warn(`TEXT_MESSAGE_END: No message found with ID '${messageId}'`);
            return emitUpdates();
          }

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
                textMessageBuffer:
                  typeof targetMessage.content === "string" ? targetMessage.content : "",
              }),
          );
          applyMutation(mutation);

          await Promise.all(
            subscribers.map((subscriber) => {
              subscriber.onNewMessage?.({
                message: targetMessage,
                messages,
                state,
                agent,
                input,
              });
            }),
          );

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
              targetMessage = messages[messages.length - 1] as AssistantMessage;
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
          const { toolCallId, delta } = event as ToolCallArgsEvent;

          // Find the message containing this tool call
          const targetMessage = messages.find((m) =>
            (m as AssistantMessage).toolCalls?.some((tc) => tc.id === toolCallId),
          ) as AssistantMessage;

          if (!targetMessage) {
            console.warn(
              `TOOL_CALL_ARGS: No message found containing tool call with ID '${toolCallId}'`,
            );
            return emitUpdates();
          }

          // Find the specific tool call
          const targetToolCall = targetMessage.toolCalls!.find((tc) => tc.id === toolCallId);
          if (!targetToolCall) {
            console.warn(`TOOL_CALL_ARGS: No tool call found with ID '${toolCallId}'`);
            return emitUpdates();
          }

          const mutation = await runSubscribersWithMutation(
            subscribers,
            messages,
            state,
            (subscriber, messages, state) => {
              const toolCallBuffer = targetToolCall.function.arguments;
              const toolCallName = targetToolCall.function.name;
              let partialToolCallArgs = {};
              try {
                // Parse from toolCallBuffer only (before current delta is applied)
                partialToolCallArgs = untruncateJson(toolCallBuffer);
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
            // Append the arguments to the correct tool call by ID
            targetToolCall.function.arguments += delta;
            applyMutation({ messages });
          }

          return emitUpdates();
        }

        case EventType.TOOL_CALL_END: {
          const { toolCallId } = event as ToolCallEndEvent;

          // Find the message containing this tool call
          const targetMessage = messages.find((m) =>
            (m as AssistantMessage).toolCalls?.some((tc) => tc.id === toolCallId),
          ) as AssistantMessage;

          if (!targetMessage) {
            console.warn(
              `TOOL_CALL_END: No message found containing tool call with ID '${toolCallId}'`,
            );
            return emitUpdates();
          }

          // Find the specific tool call
          const targetToolCall = targetMessage.toolCalls!.find((tc) => tc.id === toolCallId);
          if (!targetToolCall) {
            console.warn(`TOOL_CALL_END: No tool call found with ID '${toolCallId}'`);
            return emitUpdates();
          }

          const mutation = await runSubscribersWithMutation(
            subscribers,
            messages,
            state,
            (subscriber, messages, state) => {
              const toolCallArgsString = targetToolCall.function.arguments;
              const toolCallName = targetToolCall.function.name;
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

          await Promise.all(
            subscribers.map((subscriber) => {
              subscriber.onNewToolCall?.({
                toolCall: targetToolCall,
                messages,
                state,
                agent,
                input,
              });
            }),
          );

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

            await Promise.all(
              subscribers.map((subscriber) => {
                subscriber.onNewMessage?.({
                  message: toolMessage,
                  messages,
                  state,
                  agent,
                  input,
                });
              }),
            );

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
              // If patch failed, only emit updates if there were subscriber mutations
              // This prevents emitting updates when both patch fails AND no subscriber mutations
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

        case EventType.ACTIVITY_SNAPSHOT: {
          const activityEvent = event as ActivitySnapshotEvent;
          const existingIndex = messages.findIndex((m) => m.id === activityEvent.messageId);
          const existingMessage = existingIndex >= 0 ? messages[existingIndex] : undefined;
          const existingActivityMessage =
            existingMessage?.role === "activity" ? (existingMessage as ActivityMessage) : undefined;
          const replace = activityEvent.replace ?? true;

          const mutation = await runSubscribersWithMutation(
            subscribers,
            messages,
            state,
            (subscriber, messages, state) =>
              subscriber.onActivitySnapshotEvent?.({
                event: activityEvent,
                messages,
                state,
                agent,
                input,
                activityMessage: existingActivityMessage,
                existingMessage,
              }),
          );
          applyMutation(mutation);

          if (mutation.stopPropagation !== true) {
            const activityMessage: ActivityMessage = {
              id: activityEvent.messageId,
              role: "activity",
              activityType: activityEvent.activityType,
              content: structuredClone_(activityEvent.content),
            };

            let createdMessage: ActivityMessage | undefined;

            if (existingIndex === -1) {
              messages.push(activityMessage);
              createdMessage = activityMessage;
            } else if (existingActivityMessage) {
              if (replace) {
                messages[existingIndex] = {
                  ...existingActivityMessage,
                  activityType: activityEvent.activityType,
                  content: structuredClone_(activityEvent.content),
                };
              }
            } else if (replace) {
              messages[existingIndex] = activityMessage;
              createdMessage = activityMessage;
            }

            applyMutation({ messages });

            if (createdMessage) {
              await Promise.all(
                subscribers.map((subscriber) =>
                  subscriber.onNewMessage?.({
                    message: createdMessage,
                    messages,
                    state,
                    agent,
                    input,
                  }),
                ),
              );
            }
          }

          return emitUpdates();
        }

        case EventType.ACTIVITY_DELTA: {
          const activityEvent = event as ActivityDeltaEvent;
          const existingIndex = messages.findIndex((m) => m.id === activityEvent.messageId);
          if (existingIndex === -1) {
            console.warn(
              `ACTIVITY_DELTA: No message found with ID '${activityEvent.messageId}' to apply patch`,
            );
            return emitUpdates();
          }

          const existingMessage = messages[existingIndex];
          if (existingMessage.role !== "activity") {
            console.warn(
              `ACTIVITY_DELTA: Message '${activityEvent.messageId}' is not an activity message`,
            );
            return emitUpdates();
          }

          const existingActivityMessage = existingMessage as ActivityMessage;

          const mutation = await runSubscribersWithMutation(
            subscribers,
            messages,
            state,
            (subscriber, messages, state) =>
              subscriber.onActivityDeltaEvent?.({
                event: activityEvent,
                messages,
                state,
                agent,
                input,
                activityMessage: existingActivityMessage,
              }),
          );
          applyMutation(mutation);

          if (mutation.stopPropagation !== true) {
            try {
              const baseContent = structuredClone_(existingActivityMessage.content ?? {});

              const result = applyPatch(
                baseContent,
                activityEvent.patch ?? [],
                true,
                false,
              );
              const updatedContent = result.newDocument as ActivityMessage["content"];

              messages[existingIndex] = {
                ...existingActivityMessage,
                content: structuredClone_(updatedContent),
                activityType: activityEvent.activityType,
              };

              applyMutation({ messages });
            } catch (error: unknown) {
              const errorMessage = error instanceof Error ? error.message : String(error);
              console.warn(
                `Failed to apply activity patch for '${activityEvent.messageId}': ${errorMessage}`,
              );
            }
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

          // Handle input.messages if present and stopPropagation is not set
          if (mutation.stopPropagation !== true) {
            const runStartedEvent = event as RunStartedEvent;

            // Check if the event contains input with messages
            if (runStartedEvent.input?.messages) {
              // Add messages that aren't already present (checked by ID)
              for (const message of runStartedEvent.input.messages) {
                const existingMessage = messages.find((m) => m.id === message.id);
                if (!existingMessage) {
                  messages.push(message);
                }
              }

              // Apply mutation to emit the updated messages
              applyMutation({ messages });
            }
          }

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
    // Only use defaultIfEmpty when there are subscribers to avoid emitting empty updates
    // when patches fail and there are no subscribers (like in state patching test)
    subscribers.length > 0 ? defaultIfEmpty({} as AgentStateMutation) : (stream: any) => stream,
  );
};

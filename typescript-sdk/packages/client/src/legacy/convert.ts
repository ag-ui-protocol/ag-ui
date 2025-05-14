import { mergeMap } from "rxjs/operators";
import { applyPatch } from "fast-json-patch";

import {
  BaseEvent,
  EventType,
  TextMessageStartEvent,
  TextMessageContentEvent,
  TextMessageEndEvent,
  ToolCallStartEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  CustomEvent,
  StateSnapshotEvent,
  StepStartedEvent,
  Message,
  StateDeltaEvent,
  MessagesSnapshotEvent,
  ToolCall,
} from "@ag-ui/core";
import { Observable } from "rxjs";
import {
  LegacyTextMessageStart,
  LegacyTextMessageContent,
  LegacyTextMessageEnd,
  LegacyActionExecutionStart,
  LegacyActionExecutionArgs,
  LegacyActionExecutionEnd,
  LegacyRuntimeEventTypes,
  LegacyRuntimeProtocolEvent,
  LegacyMetaEvent,
  LegacyAgentStateMessage,
  LegacyMessage,
  LegacyTextMessage,
  LegacyActionExecutionMessage,
  LegacyResultMessage,
} from "./types";
import untruncateJson from "untruncate-json";

interface PredictStateValue {
  state_key: string;
  tool: string;
  tool_argument: string;
}

export const convertToLegacyEvents =
  (threadId: string, runId: string, agentName: string) =>
  (events$: Observable<BaseEvent>): Observable<LegacyRuntimeProtocolEvent> => {
    let currentState: any = {};
    let running = true;
    let active = true;
    let nodeName = "";
    let syncedMessages: Message[] | null = null;
    let predictState: PredictStateValue[] | null = null;
    let currentToolCalls: ToolCall[] = [];

    const updateCurrentState = (newState: any) => {
      // the legacy protocol will only support object state
      if (typeof newState === "object" && newState !== null) {
        if ("messages" in newState) {
          delete newState.messages;
        }
        currentState = newState;
      }
    };

    return events$.pipe(
      mergeMap((event) => {
        switch (event.type) {
          case EventType.TEXT_MESSAGE_START: {
            const startEvent = event as TextMessageStartEvent;
            return [
              {
                type: LegacyRuntimeEventTypes.enum.TextMessageStart,
                messageId: startEvent.messageId,
              } as LegacyTextMessageStart,
            ];
          }
          case EventType.TEXT_MESSAGE_CONTENT: {
            const contentEvent = event as TextMessageContentEvent;
            return [
              {
                type: LegacyRuntimeEventTypes.enum.TextMessageContent,
                messageId: contentEvent.messageId,
                content: contentEvent.delta,
              } as LegacyTextMessageContent,
            ];
          }
          case EventType.TEXT_MESSAGE_END: {
            const endEvent = event as TextMessageEndEvent;
            return [
              {
                type: LegacyRuntimeEventTypes.enum.TextMessageEnd,
                messageId: endEvent.messageId,
              } as LegacyTextMessageEnd,
            ];
          }
          case EventType.TOOL_CALL_START: {
            const startEvent = event as ToolCallStartEvent;

            currentToolCalls.push({
              id: startEvent.toolCallId,
              type: "function",
              function: {
                name: startEvent.toolCallName,
                arguments: "",
              },
            });

            active = true;

            return [
              {
                type: LegacyRuntimeEventTypes.enum.ActionExecutionStart,
                actionExecutionId: startEvent.toolCallId,
                actionName: startEvent.toolCallName,
                parentMessageId: startEvent.parentMessageId,
              } as LegacyActionExecutionStart,
            ];
          }
          case EventType.TOOL_CALL_ARGS: {
            const argsEvent = event as ToolCallArgsEvent;

            const currentToolCall = currentToolCalls[currentToolCalls.length - 1];
            currentToolCall.function.arguments += argsEvent.delta;
            let didUpdateState = false;

            if (predictState) {
              let currentPredictState = predictState.find(
                (s) => s.tool == currentToolCall.function.name,
              );

              if (currentPredictState) {
                try {
                  const currentArgs = JSON.parse(
                    untruncateJson(currentToolCall.function.arguments),
                  );
                  if (
                    currentPredictState.tool_argument &&
                    currentPredictState.tool_argument in currentArgs
                  ) {
                    updateCurrentState({
                      ...currentState,
                      [currentPredictState.state_key]:
                        currentArgs[currentPredictState.tool_argument],
                    });
                    didUpdateState = true;
                  } else if (!currentPredictState.tool_argument) {
                    updateCurrentState({
                      ...currentState,
                      [currentPredictState.state_key]: currentArgs,
                    });
                    didUpdateState = true;
                  }
                } catch (e) {}
              }
            }

            return [
              {
                type: LegacyRuntimeEventTypes.enum.ActionExecutionArgs,
                actionExecutionId: argsEvent.toolCallId,
                args: argsEvent.delta,
              } as LegacyActionExecutionArgs,
              ...(didUpdateState
                ? [
                    {
                      type: LegacyRuntimeEventTypes.enum.AgentStateMessage,
                      threadId,
                      agentName,
                      nodeName,
                      runId,
                      running,
                      role: "assistant",
                      state: JSON.stringify(currentState),
                      active,
                    },
                  ]
                : []),
            ];
          }
          case EventType.TOOL_CALL_END: {
            const endEvent = event as ToolCallEndEvent;
            return [
              {
                type: LegacyRuntimeEventTypes.enum.ActionExecutionEnd,
                actionExecutionId: endEvent.toolCallId,
              } as LegacyActionExecutionEnd,
            ];
          }
          case EventType.RAW: {
            // The legacy protocol doesn't support raw events
            return [];
          }
          case EventType.CUSTOM: {
            const customEvent = event as CustomEvent;
            switch (customEvent.name) {
              case "Exit":
                running = false;
                break;
              case "PredictState":
                predictState = customEvent.value as PredictStateValue[];
                break;
            }

            return [
              {
                type: LegacyRuntimeEventTypes.enum.MetaEvent,
                name: customEvent.name,
                value: customEvent.value,
              } as LegacyMetaEvent,
            ];
          }
          case EventType.STATE_SNAPSHOT: {
            const stateEvent = event as StateSnapshotEvent;
            updateCurrentState(stateEvent.snapshot);

            return [
              {
                type: LegacyRuntimeEventTypes.enum.AgentStateMessage,
                threadId,
                agentName,
                nodeName,
                runId,
                running,
                role: "assistant",
                state: JSON.stringify(currentState),
                active,
              } as LegacyAgentStateMessage,
            ];
          }
          case EventType.STATE_DELTA: {
            const deltaEvent = event as StateDeltaEvent;
            const result = applyPatch(currentState, deltaEvent.delta, true, false);
            if (!result) {
              return [];
            }
            updateCurrentState(result.newDocument);

            return [
              {
                type: LegacyRuntimeEventTypes.enum.AgentStateMessage,
                threadId,
                agentName,
                nodeName,
                runId,
                running,
                role: "assistant",
                state: JSON.stringify(currentState),
                active,
              } as LegacyAgentStateMessage,
            ];
          }
          case EventType.MESSAGES_SNAPSHOT: {
            const messagesSnapshot = event as MessagesSnapshotEvent;
            syncedMessages = messagesSnapshot.messages;
            return [
              {
                type: LegacyRuntimeEventTypes.enum.AgentStateMessage,
                threadId,
                agentName,
                nodeName,
                runId,
                running,
                role: "assistant",
                state: JSON.stringify({
                  ...currentState,
                  ...(syncedMessages ? { messages: syncedMessages } : {}),
                }),
                active: true,
              } as LegacyAgentStateMessage,
            ];
          }
          case EventType.RUN_STARTED: {
            // There is nothing to do in the legacy protocol
            return [];
          }
          case EventType.RUN_FINISHED: {
            if (syncedMessages) {
              currentState.messages = syncedMessages;
            }

            return [
              {
                type: LegacyRuntimeEventTypes.enum.AgentStateMessage,
                threadId,
                agentName,
                nodeName,
                runId,
                running,
                role: "assistant",
                state: JSON.stringify({
                  ...currentState,
                  ...(syncedMessages
                    ? {
                        messages: convertMessagesToLegacyFormat(syncedMessages),
                      }
                    : {}),
                }),
                active: false,
              } as LegacyAgentStateMessage,
            ];
          }
          case EventType.RUN_ERROR: {
            // legacy protocol does not have an event for errors
            console.error("Run error", event);
            return [];
          }
          case EventType.STEP_STARTED: {
            const stepStarted = event as StepStartedEvent;
            nodeName = stepStarted.stepName;

            currentToolCalls = [];
            predictState = null;

            return [
              {
                type: LegacyRuntimeEventTypes.enum.AgentStateMessage,
                threadId,
                agentName,
                nodeName,
                runId,
                running,
                role: "assistant",
                state: JSON.stringify(currentState),
                active: true,
              } as LegacyAgentStateMessage,
            ];
          }
          case EventType.STEP_FINISHED: {
            currentToolCalls = [];
            predictState = null;

            return [
              {
                type: LegacyRuntimeEventTypes.enum.AgentStateMessage,
                threadId,
                agentName,
                nodeName,
                runId,
                running,
                role: "assistant",
                state: JSON.stringify(currentState),
                active: false,
              } as LegacyAgentStateMessage,
            ];
          }
          default: {
            return [];
          }
        }
      }),
    );
  };

export function convertMessagesToLegacyFormat(messages: Message[]): LegacyMessage[] {
  const result: LegacyMessage[] = [];

  for (const message of messages) {
    if (message.role === "assistant" || message.role === "user" || message.role === "system") {
      if (message.content) {
        const textMessage: LegacyTextMessage = {
          id: message.id,
          role: message.role,
          content: message.content,
        };
        result.push(textMessage);
      }
      if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
        for (const toolCall of message.toolCalls) {
          const actionExecutionMessage: LegacyActionExecutionMessage = {
            id: toolCall.id,
            name: toolCall.function.name,
            arguments: JSON.parse(toolCall.function.arguments),
            parentMessageId: message.id,
          };
          result.push(actionExecutionMessage);
        }
      }
    } else if (message.role === "tool") {
      let actionName = "unknown";
      for (const m of messages) {
        if (m.role === "assistant" && m.toolCalls?.length) {
          for (const toolCall of m.toolCalls) {
            if (toolCall.id === message.toolCallId) {
              actionName = toolCall.function.name;
              break;
            }
          }
        }
      }
      const toolMessage: LegacyResultMessage = {
        id: message.id,
        result: message.content,
        actionExecutionId: message.toolCallId,
        actionName,
      };
      result.push(toolMessage);
    }
  }

  return result;
}

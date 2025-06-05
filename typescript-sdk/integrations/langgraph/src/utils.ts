import { Message as LangGraphMessage } from "@langchain/langgraph-sdk";
import { State, SchemaKeys } from "./types";
import { Message, ToolCall } from "@ag-ui/core";

export const DEFAULT_SCHEMA_KEYS = ["tools"];

export function filterObjectBySchemaKeys(obj: Record<string, any>, schemaKeys: string[]) {
  return Object.fromEntries(Object.entries(obj).filter(([key]) => schemaKeys.includes(key)));
}

export function getStreamPayloadInput({
  mode,
  state,
  schemaKeys,
}: {
  mode: "start" | "continue";
  state: State;
  schemaKeys: SchemaKeys;
}) {
  let input = mode === "start" ? state : null;
  // Do not input keys that are not part of the input schema
  if (input && schemaKeys?.input) {
    input = filterObjectBySchemaKeys(input, [...DEFAULT_SCHEMA_KEYS, ...schemaKeys.input]);
  }

  return input;
}

export function langchainMessagesToAgui(messages: LangGraphMessage[]): Message[] {
  return messages.map((message) => {
    switch (message.type) {
      case "human":
        return {
          id: message.id!,
          role: "user",
          content: stringifyIfNeeded(message.content),
        };
      case "ai":
        return {
          id: message.id!,
          role: "assistant",
          content: stringifyIfNeeded(message.content),
          toolCalls: message.tool_calls?.map((tc) => ({
            id: tc.id!,
            type: "function",
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.args),
            },
          })),
        };
      case "system":
        return {
          id: message.id!,
          role: "system",
          content: stringifyIfNeeded(message.content),
        };
      case "tool":
        return {
          id: message.id!,
          role: "tool",
          content: stringifyIfNeeded(message.content),
          toolCallId: message.tool_call_id,
        };
      default:
        throw new Error("message type returned from LangGraph is not supported.");
    }
  });
}

export function aguiMessagesToLangChain(messages: Message[]): LangGraphMessage[] {
  return messages.map((message, index) => {
    switch (message.role) {
      case "user":
        return {
          id: message.id,
          role: message.role,
          content: message.content,
          type: "human",
        };
      case "assistant":
        return {
          id: message.id,
          type: "ai",
          role: message.role,
          content: message.content ?? "",
          tool_calls: (message.toolCalls ?? []).map((tc: ToolCall) => ({
            id: tc.id,
            name: tc.function.name,
            args: JSON.parse(tc.function.arguments),
            type: "tool_call",
          })),
        };
      case "system":
        return {
          id: message.id,
          role: message.role,
          content: message.content,
          type: "system",
        };
      case "tool":
        return {
          content: message.content,
          role: message.role,
          type: message.role,
          tool_call_id: message.toolCallId,
          id: message.id,
        };
      default:
        console.error(`Message role ${message.role} is not implemented`);
        throw new Error("message role is not supported.");
    }
  });
}

function stringifyIfNeeded(item: any) {
  if (typeof item === "string") return item;
  return JSON.stringify(item);
}

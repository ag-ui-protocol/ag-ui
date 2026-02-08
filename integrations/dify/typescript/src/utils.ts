import type { Message } from "@ag-ui/core";
import { DifyMessage } from "./types";

/**
 * Convert AG-UI messages to Dify message format
 * @param messages - AG-UI messages to convert
 * @returns Array of Dify-formatted messages
 */
export function aguiMessagesToDify(messages: Message[]): DifyMessage[] {
  return messages.map(msg => ({
    role: msg.role,
    content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
  }));
}

/**
 * Convert Dify messages to AG-UI message format
 * @param messages - Dify messages to convert
 * @returns Array of AG-UI formatted messages
 */
export function difyMessagesToAgui(messages: DifyMessage[]): Message[] {
  return messages.map(msg => ({
    role: msg.role as Message["role"],
    content: msg.content,
  })) as Message[];
}

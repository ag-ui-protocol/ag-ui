/**
 * Message format converters
 */

import type { Message } from '@ag-ui/client';
import type { ConvertedMessage } from '../types';

/**
 * Convert AG-UI messages to a format suitable for Claude SDK
 */
export function convertAgUiMessagesToPrompt(messages: Message[]): string {
  // For Claude SDK, we typically extract the last user message as the prompt
  // The SDK maintains conversation history internally (in persistent mode)
  
  // Find the last user message
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'user') {
      return extractMessageContent(msg);
    }
  }

  // If no user message found, return a default prompt
  return 'Hello';
}

/**
 * Extract text content from a message
 */
export function extractMessageContent(message: Message): string {
  if (typeof message.content === 'string') {
    return message.content;
  }

  if (Array.isArray(message.content)) {
    return message.content
      .map((block: any) => {
        if (typeof block === 'string') {
          return block;
        }
        if (block.type === 'text') {
          return block.text || '';
        }
        // For other types (image, file, etc.), we might need special handling
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }

  return String(message.content);
}

/**
 * Convert AG-UI message to Claude message format
 */
export function convertAgUiMessageToClaude(message: Message): ConvertedMessage {
  const role = message.role as 'user' | 'assistant' | 'system';
  const content = extractMessageContent(message);

  return {
    role,
    content,
  };
}

/**
 * Convert multiple AG-UI messages to Claude format
 */
export function convertAgUiMessagesToClaude(messages: Message[]): ConvertedMessage[] {
  return messages.map(convertAgUiMessageToClaude);
}

/**
 * Check if messages contain tool results
 */
export function hasToolResults(messages: Message[]): boolean {
  return messages.some((msg) => {
    if (typeof msg.content === 'string') {
      return false;
    }
    if (Array.isArray(msg.content)) {
      return msg.content.some((block: any) => {
        return typeof block === 'object' && block.type === 'tool_result';
      });
    }
    return false;
  });
}

/**
 * Extract tool results from messages
 */
export function extractToolResults(messages: Message[]): Array<{
  toolCallId: string;
  result: string;
}> {
  const results: Array<{ toolCallId: string; result: string }> = [];

  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      continue;
    }

    if (Array.isArray(msg.content)) {
      for (const block of msg.content as any[]) {
        if (typeof block === 'object' && block.type === 'tool_result') {
          results.push({
            toolCallId: (block as any).toolCallId || (block as any).tool_use_id || '',
            result: (block as any).result || (block as any).content || '',
          });
        }
      }
    }
  }

  return results;
}

/**
 * Generate a unique run ID
 */
export function generateRunId(): string {
  return `run_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Generate a unique message ID
 */
export function generateMessageId(prefix: string = 'msg'): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Safely parse JSON string
 */
export function safeJsonParse(json: string, defaultValue: any = null): any {
  try {
    return JSON.parse(json);
  } catch {
    return defaultValue;
  }
}

/**
 * Safely stringify JSON
 */
export function safeJsonStringify(obj: any, defaultValue: string = '{}'): string {
  try {
    return JSON.stringify(obj);
  } catch {
    return defaultValue;
  }
}

/**
 * Check if a message is a tool result submission
 */
export function isToolResultSubmission(messages: Message[]): boolean {
  // Check if the last message contains tool results
  if (messages.length === 0) {
    return false;
  }

  const lastMessage = messages[messages.length - 1];
  return hasToolResults([lastMessage]);
}

/**
 * Format error message for display
 */
export function formatErrorMessage(error: any): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return 'An unknown error occurred';
}

/**
 * Truncate text to a maximum length
 */
export function truncateText(text: string, maxLength: number = 1000): string {
  if (text.length <= maxLength) {
    return text;
  }
  return text.slice(0, maxLength) + '...';
}

/**
 * Merge consecutive text blocks
 */
export function mergeTextBlocks(blocks: Array<{ type: string; text?: string }>): string {
  return blocks
    .filter((block: any) => block.type === 'text' && block.text)
    .map((block: any) => block.text)
    .join('');
}


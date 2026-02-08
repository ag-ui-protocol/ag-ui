/**
 * Event handlers for Claude SDK stream processing.
 *
 * Breaks down stream processing into focused handler functions.
 */

import { Subscriber } from "rxjs";
import { EventType, randomUUID } from "@ag-ui/client";
import type { BaseEvent } from "@ag-ui/core";
import type { BetaToolUseBlock } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import {
  STATE_MANAGEMENT_TOOL_NAME,
  STATE_MANAGEMENT_TOOL_FULL_NAME,
} from "./config";
import { stripMcpPrefix } from "./utils";
import type { ProcessedEvent } from "./types";

/**
 * Result from handling a ToolUseBlock.
 */
export type HandleToolUseResult = {
  /** Updated state (or null if unchanged) */
  updatedState: unknown | null;
};

/**
 * Handle ToolUseBlock from Claude SDK.
 *
 * Intercepts state management tool calls and emits STATE_SNAPSHOT.
 * For regular tools, emits TOOL_CALL_START/ARGS events.
 */
export function handleToolUseBlock(
  block: BetaToolUseBlock,
  parentToolUseId: string | undefined,
  threadId: string,
  runId: string,
  currentState: unknown,
  subscriber: Subscriber<ProcessedEvent>
): HandleToolUseResult {
  const toolName = block.name ?? "unknown";
  const toolInput = (block.input as Record<string, unknown>) ?? {};
  const toolId = block.id ?? randomUUID();

  // Strip MCP prefix for client matching (same as streaming path)
  const toolDisplayName = stripMcpPrefix(toolName);
  if (toolDisplayName !== toolName) {
    console.debug(
      `[ClaudeAdapter] Stripped MCP prefix in handler: ${toolName} -> ${toolDisplayName}`
    );
  }

  console.debug(`[ClaudeAdapter] ToolUseBlock detected: ${toolName}`);

  // Intercept state management tool calls (check both prefixed and unprefixed names)
  if (
    toolName === STATE_MANAGEMENT_TOOL_NAME ||
    toolName === STATE_MANAGEMENT_TOOL_FULL_NAME
  ) {
    console.debug(
      "[ClaudeAdapter] Intercepting ag_ui_update_state tool call"
    );

    // Extract state updates from tool input
    let stateUpdates: unknown = toolInput.state_updates ?? {};

    // Parse if it's a JSON string
    if (typeof stateUpdates === "string") {
      try {
        stateUpdates = JSON.parse(stateUpdates);
        console.debug(
          "[ClaudeAdapter] Parsed state_updates from JSON string"
        );
      } catch {
        console.warn(
          "[ClaudeAdapter] Failed to parse state_updates JSON"
        );
        stateUpdates = {};
      }
    }

    // Update current state
    let newState: unknown;
    if (
      typeof currentState === "object" &&
      currentState !== null &&
      typeof stateUpdates === "object" &&
      stateUpdates !== null
    ) {
      newState = {
        ...(currentState as Record<string, unknown>),
        ...(stateUpdates as Record<string, unknown>),
      };
    } else {
      newState = stateUpdates;
    }

    // Emit STATE_SNAPSHOT with updated state
    subscriber.next({
      type: EventType.STATE_SNAPSHOT,
      snapshot: newState,
    });

    console.debug("[ClaudeAdapter] Emitted STATE_SNAPSHOT with updated state");
    return { updatedState: newState };
  }

  // Regular tool handling for non-state tools
  subscriber.next({
    type: EventType.TOOL_CALL_START,
    threadId,
    runId,
    toolCallId: toolId,
    toolCallName: toolDisplayName, // Use unprefixed name
    parentMessageId: parentToolUseId,
  });

  if (toolInput && Object.keys(toolInput).length > 0) {
    subscriber.next({
      type: EventType.TOOL_CALL_ARGS,
      threadId,
      runId,
      toolCallId: toolId,
      delta: JSON.stringify(toolInput),
    });
  }

  return { updatedState: null };
}

/**
 * Handle tool result content from Claude SDK.
 *
 * Parses Claude SDK tool result format and emits TOOL_CALL_END + TOOL_CALL_RESULT.
 * Claude SDK tools return: [{"type": "text", "text": "{json_data}"}]
 * Frontend expects just the parsed json_data.
 */
export function handleToolResultBlock(
  toolUseId: string,
  content: unknown,
  threadId: string,
  runId: string,
  subscriber: Subscriber<ProcessedEvent>
): void {
  // Parse tool result content for frontend rendering
  let resultStr = "";
  if (content != null) {
    try {
      // If content is a list of content blocks (Claude SDK format)
      if (Array.isArray(content) && content.length > 0) {
        const firstBlock = content[0] as Record<string, unknown>;
        if (firstBlock?.type === "text") {
          const textContent = (firstBlock.text as string) ?? "";
          // Try to parse as JSON (tools often return JSON strings)
          try {
            const parsedJson = JSON.parse(textContent);
            resultStr = JSON.stringify(parsedJson);
          } catch {
            // Not JSON, use as-is
            resultStr = textContent;
          }
        } else {
          // Fallback: stringify the whole content
          resultStr = JSON.stringify(content);
        }
      } else {
        // Fallback: stringify as-is
        resultStr = JSON.stringify(content);
      }
    } catch {
      resultStr = String(content);
    }
  }

  // Emit ToolCallEnd to signal completion
  subscriber.next({
    type: EventType.TOOL_CALL_END,
    threadId,
    runId,
    toolCallId: toolUseId,
  });

  // Emit ToolCallResult with the actual result content
  subscriber.next({
    type: EventType.TOOL_CALL_RESULT,
    threadId,
    runId,
    messageId: `${toolUseId}-result`,
    toolCallId: toolUseId,
    content: resultStr,
    role: "tool",
  });
}

/**
 * Emit a system message as AG-UI text message events.
 */
export function emitSystemMessageEvents(
  subscriber: Subscriber<ProcessedEvent>,
  threadId: string,
  runId: string,
  message: string
): void {
  const msgId = randomUUID();
  subscriber.next({
    type: EventType.TEXT_MESSAGE_START,
    threadId,
    runId,
    messageId: msgId,
    role: "system",
  });
  subscriber.next({
    type: EventType.TEXT_MESSAGE_CONTENT,
    threadId,
    runId,
    messageId: msgId,
    delta: message,
  });
  subscriber.next({
    type: EventType.TEXT_MESSAGE_END,
    threadId,
    runId,
    messageId: msgId,
  });
}

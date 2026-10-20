/**
 * Event handlers for Claude SDK stream processing.
 *
 * Breaks down stream processing into focused handler functions.
 */

import { Subscriber } from "rxjs";
import { EventType, randomUUID } from "@ag-ui/client";
import type { BetaToolUseBlock } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import {
  stripMcpPrefix,
  isStateManagementTool,
  mergeStateUpdate,
} from "./utils";
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
  subscriber: Subscriber<ProcessedEvent>,
): HandleToolUseResult {
  const toolName = block.name ?? "unknown";
  const toolInput = (block.input as Record<string, unknown>) ?? {};
  const toolId = block.id ?? randomUUID();

  // Strip MCP prefix for client matching (same as streaming path)
  const toolDisplayName = stripMcpPrefix(toolName);
  if (toolDisplayName !== toolName) {
    console.debug(
      `[ClaudeAdapter] Stripped MCP prefix in handler: ${toolName} -> ${toolDisplayName}`,
    );
  }

  console.debug(`[ClaudeAdapter] ToolUseBlock detected: ${toolName}`);

  // Intercept state management tool calls (check both prefixed and unprefixed names)
  if (isStateManagementTool(toolName)) {
    console.debug("[ClaudeAdapter] Intercepting ag_ui_update_state tool call");

    let newState: unknown;
    try {
      newState = mergeStateUpdate(currentState, toolInput);
    } catch (error) {
      subscriber.next({
        type: EventType.CUSTOM,
        name: "state_update_error",
        value: { error: String(error) },
      });
      return { updatedState: null };
    }

    if (JSON.stringify(newState) !== JSON.stringify(currentState)) {
      subscriber.next({
        type: EventType.STATE_SNAPSHOT,
        snapshot: newState,
      });
      console.debug(
        "[ClaudeAdapter] Emitted STATE_SNAPSHOT with updated state",
      );
    }
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

  // Emit TOOL_CALL_END so the runtime doesn't think the tool call is still active.
  // In the streaming path this is emitted at content_block_stop, but when tools
  // arrive only via the complete `assistant` message (non-streaming), this fallback
  // is the only place that closes the tool call.
  subscriber.next({
    type: EventType.TOOL_CALL_END,
    threadId,
    runId,
    toolCallId: toolId,
  });

  return { updatedState: null };
}

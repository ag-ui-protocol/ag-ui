/**
 * Express route handler for Shared State agent
 */

import type { Request, Response } from "express";
import { EventType, type StateSnapshotEvent } from "@ag-ui/core";
import { getSharedStateAgent } from "./agent.js";
import {
  validateMessagesRequest,
  getOrCreateThreadId,
  generateRunId,
  setSSEHeaders,
  writeSSEEvent,
  createSSEErrorHandler,
} from "../../utils/agent-utils.js";
import { ensureTools, TODO_MANAGEMENT_TOOLS } from "../../utils/tool-definitions.js";

/**
 * In-memory state storage per thread
 * In production, this should be replaced with a persistent store (Redis, DB, etc.)
 */
const threadStates = new Map<string, any>();

/**
 * POST /shared_state
 *
 * Demonstrates persistent state management across multiple messages.
 * State is maintained per thread and updated with each interaction.
 *
 * Request body:
 * - messages: Array of chat messages
 * - context: Optional context object
 * - tools: Optional array of tools
 */
export async function sharedStateHandler(req: Request, res: Response) {
  // Validate request
  if (!validateMessagesRequest(req, res)) {
    return;
  }

  // Set SSE headers
  setSSEHeaders(res);

  try {
    const { messages, context, tools } = req.body;
    const threadId = getOrCreateThreadId(req);

    // Retrieve previous state for this thread, or initialize empty
    const previousState = threadStates.get(threadId) || { todos: [] };

    // Create agent input with previous state and todo management tools
    const input = {
      threadId,
      runId: generateRunId(),
      messages,
      tools: ensureTools(tools, TODO_MANAGEMENT_TOOLS), // Include todo management tools
      context: context ? [{ description: "Request context", value: JSON.stringify(context) }] : [],
      state: previousState, // Pass previous state
      forwardedProps: {},
    };

    const agent = getSharedStateAgent();
    const observable = agent.run(input);

    const subscription = observable.subscribe({
      next: (event) => {
        // Persist state updates
        if (event.type === EventType.STATE_SNAPSHOT) {
          const stateEvent = event as StateSnapshotEvent;
          threadStates.set(threadId, stateEvent.snapshot);
        }

        writeSSEEvent(res, event, threadId);
      },
      error: createSSEErrorHandler(res, threadId, {
        agentType: "shared_state",
        runId: input.runId,
      }),
      complete: () => {
        res.end();
      },
    });

    // Handle client disconnect
    req.on("close", () => {
      subscription.unsubscribe();
    });
  } catch (error) {
    createSSEErrorHandler(res, "", { agentType: "shared_state" })(error);
  }
}

/**
 * Optional: Clear state for a specific thread
 * Could be exposed as DELETE /shared_state/:threadId
 */
export function clearThreadState(threadId: string): void {
  threadStates.delete(threadId);
}

/**
 * Optional: Get current state for a thread
 * Could be exposed as GET /shared_state/:threadId
 */
export function getThreadState(threadId: string): any {
  return threadStates.get(threadId) || { todos: [] };
}

/**
 * Express route handler for Agentic Chat agent
 */

import type { Request, Response } from "express";
import { getAgenticChatAgent } from "./agent.js";
import {
  validateMessagesRequest,
  createAgentInput,
  setSSEHeaders,
  writeSSEEvent,
  createSSEErrorHandler,
} from "../../utils/agent-utils.js";

/**
 * POST /agentic_chat
 *
 * Handles chat requests and streams AG-UI protocol events back to the client.
 *
 * Request body:
 * - messages: Array of chat messages
 * - context: Optional context object
 * - tools: Optional array of tools
 */
export async function agenticChatHandler(req: Request, res: Response) {
  // Validate request
  if (!validateMessagesRequest(req, res)) {
    return;
  }

  // Set SSE headers
  setSSEHeaders(res);

  try {
    // Create agent input
    const input = createAgentInput(req);

    // Run the agent and stream events
    const agent = getAgenticChatAgent();
    const observable = agent.run(input);

    const subscription = observable.subscribe({
      next: (event) => {
        writeSSEEvent(res, event, input.threadId);
      },
      error: createSSEErrorHandler(res, input.threadId, {
        agentType: "agentic_chat",
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
    createSSEErrorHandler(res, "", { agentType: "agentic_chat" })(error);
  }
}

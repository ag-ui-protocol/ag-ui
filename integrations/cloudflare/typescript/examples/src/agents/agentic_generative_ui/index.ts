/**
 * Express route handler for Agentic Generative UI agent
 */

import type { Request, Response } from "express";
import { getAgenticGenerativeUiAgent } from "./agent.js";
import {
  validateMessagesRequest,
  createAgentInput,
  setSSEHeaders,
  writeSSEEvent,
  createSSEErrorHandler,
} from "../../utils/agent-utils.js";

/**
 * POST /agentic_generative_ui
 *
 * Demonstrates agentic generative UI with progressive state updates.
 * As the agent generates structured data (like task steps), STATE_SNAPSHOT
 * events are emitted so the frontend can render the UI progressively.
 *
 * Request body:
 * - messages: Array of chat messages
 * - context: Optional context object
 */
export async function agenticGenerativeUiHandler(req: Request, res: Response) {
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
    const agent = getAgenticGenerativeUiAgent();
    const observable = agent.run(input);

    const subscription = observable.subscribe({
      next: (event) => {
        writeSSEEvent(res, event, input.threadId);
      },
      error: createSSEErrorHandler(res, input.threadId, {
        agentType: "agentic_generative_ui",
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
    createSSEErrorHandler(res, "", { agentType: "agentic_generative_ui" })(error);
  }
}

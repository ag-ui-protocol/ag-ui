/**
 * Express route handler for Tool-Based Generative UI agent
 */

import type { Request, Response } from "express";
import { getToolBasedGenerativeUiAgent } from "./agent.js";
import {
  validateMessagesRequest,
  createAgentInput,
  setSSEHeaders,
  writeSSEEvent,
  createSSEErrorHandler,
} from "../../utils/agent-utils.js";
import { ensureTool, GENERATE_HAIKU_TOOL } from "../../utils/tool-definitions.js";

/**
 * POST /tool_based_generative_ui
 *
 * Demonstrates tool-based generative UI where the frontend provides tools
 * (like generate_haiku) and renders custom components for tool results.
 *
 * Request body:
 * - messages: Array of chat messages
 * - tools: Array of tools provided by the frontend (CopilotKit actions)
 * - context: Optional context object
 */
export async function toolBasedGenerativeUiHandler(req: Request, res: Response) {
  // Validate request
  if (!validateMessagesRequest(req, res)) {
    return;
  }

  // Set SSE headers
  setSSEHeaders(res);

  try {
    // Create agent input with haiku tool
    const input = createAgentInput(req);
    input.tools = ensureTool(input.tools, GENERATE_HAIKU_TOOL);

    // Run the agent and stream events
    const agent = getToolBasedGenerativeUiAgent();
    const observable = agent.run(input);

    const subscription = observable.subscribe({
      next: (event) => {
        writeSSEEvent(res, event, input.threadId);
      },
      error: createSSEErrorHandler(res, input.threadId, {
        agentType: "tool_based_generative_ui",
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
    createSSEErrorHandler(res, "", { agentType: "tool_based_generative_ui" })(error);
  }
}

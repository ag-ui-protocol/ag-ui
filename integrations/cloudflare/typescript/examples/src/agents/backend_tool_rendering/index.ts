/**
 * Express route handler for Backend Tool Rendering agent
 */

import type { Request, Response } from "express";
import { getBackendToolRenderingAgent } from "./agent.js";
import {
  validateMessagesRequest,
  createAgentInput,
  setSSEHeaders,
  writeSSEEvent,
  createSSEErrorHandler,
} from "../../utils/agent-utils.js";
import {
  ensureTools,
  SHOW_WEATHER_TOOL,
  SHOW_STOCK_TOOL,
  SHOW_CALENDAR_TOOL,
} from "../../utils/tool-definitions.js";

export async function backendToolRenderingHandler(req: Request, res: Response) {
  // Validate request
  if (!validateMessagesRequest(req, res)) {
    return;
  }

  // Set SSE headers
  setSSEHeaders(res);

  try {
    // Create agent input with backend rendering tools
    const input = createAgentInput(req);
    input.tools = ensureTools(input.tools, [
      SHOW_WEATHER_TOOL,
      SHOW_STOCK_TOOL,
      SHOW_CALENDAR_TOOL,
    ]);

    const agent = getBackendToolRenderingAgent();
    const observable = agent.run(input);

    const subscription = observable.subscribe({
      next: (event) => {
        writeSSEEvent(res, event, input.threadId);
      },
      error: createSSEErrorHandler(res, input.threadId, {
        agentType: "backend_tool_rendering",
        runId: input.runId,
      }),
      complete: () => {
        res.end();
      },
    });

    req.on("close", () => {
      subscription.unsubscribe();
    });
  } catch (error) {
    createSSEErrorHandler(res, "", { agentType: "backend_tool_rendering" })(error);
  }
}

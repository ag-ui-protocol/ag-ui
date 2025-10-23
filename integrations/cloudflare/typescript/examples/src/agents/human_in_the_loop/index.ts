/**
 * Express route handler for Human-in-the-Loop agent
 */

import type { Request, Response } from "express";
import { getHumanInTheLoopAgent } from "./agent.js";
import {
  validateMessagesRequest,
  createAgentInput,
  setSSEHeaders,
  writeSSEEvent,
  createSSEErrorHandler,
} from "../../utils/agent-utils.js";
import { ensureTool, GENERATE_TASK_STEPS_TOOL } from "../../utils/tool-definitions.js";

export async function humanInTheLoopHandler(req: Request, res: Response) {
  // Validate request
  if (!validateMessagesRequest(req, res)) {
    return;
  }

  // Set SSE headers
  setSSEHeaders(res);

  try {
    // Create agent input with task steps tool
    const input = createAgentInput(req);
    input.tools = ensureTool(input.tools, GENERATE_TASK_STEPS_TOOL);

    const agent = getHumanInTheLoopAgent();
    const observable = agent.run(input);

    const subscription = observable.subscribe({
      next: (event) => {
        writeSSEEvent(res, event, input.threadId);
      },
      error: createSSEErrorHandler(res, input.threadId, {
        agentType: "human_in_the_loop",
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
    createSSEErrorHandler(res, "", { agentType: "human_in_the_loop" })(error);
  }
}

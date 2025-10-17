/**
 * Express route handler for Tool-Based Generative UI agent
 */

import type { Request, Response } from "express";
import { getToolBasedGenerativeUiAgent } from "./agent";

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
  const { messages, context, tools } = req.body;

  // Validate request
  if (!messages || !Array.isArray(messages)) {
    res.status(400).json({ error: "Missing or invalid 'messages' array in request body" });
    return;
  }

  // Set SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  try {
    // Prepare input for the agent
    const input = {
      threadId: req.headers["x-thread-id"] as string || `thread-${Date.now()}`,
      runId: `run-${Date.now()}-${Math.random().toString(36).substring(7)}`,
      messages,
      tools: tools || [],
      context: context ? [{ description: "Request context", value: JSON.stringify(context) }] : [],
      state: {},
      forwardedProps: {},
    };

    // Run the agent and stream events
    const agent = getToolBasedGenerativeUiAgent();
    const observable = agent.run(input);

    observable.subscribe({
      next: (event) => {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      },
      error: (error) => {
        console.error("Agent error:", error);
        res.write(
          `data: ${JSON.stringify({
            type: "RUN_ERROR",
            message: error instanceof Error ? error.message : "Unknown error",
            timestamp: Date.now(),
          })}\n\n`
        );
        res.end();
      },
      complete: () => {
        res.end();
      },
    });

    // Handle client disconnect
    req.on("close", () => {
    });
  } catch (error) {
    console.error("Handler error:", error);
    if (!res.headersSent) {
      res.status(500).json({
        error: error instanceof Error ? error.message : "Internal server error",
      });
    } else {
      res.end();
    }
  }
}

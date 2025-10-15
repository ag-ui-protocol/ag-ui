/**
 * Express route handler for Agentic Chat agent
 */

import type { Request, Response } from "express";
import { getAgenticChatAgent } from "./agent";

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
  res.setHeader("X-Accel-Buffering", "no"); // Disable buffering in nginx

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
    const agent = getAgenticChatAgent();
    const observable = agent.run(input);

    observable.subscribe({
      next: (event) => {
        // Write event to SSE stream
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      },
      error: (error) => {
        console.error("Agent error:", error);
        // Send error event
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
        // End the SSE stream
        res.end();
      },
    });

    // Handle client disconnect
    req.on("close", () => {
      console.log("Client disconnected from agentic_chat");
      // Observable will be automatically unsubscribed
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

/**
 * Tool-Based Generative UI (Agents SDK version)
 *
 * This handler demonstrates using CloudflareAgentsSDKAdapter to bridge
 * the gap between Cloudflare Agents SDK patterns and AG-UI protocol.
 *
 * ## Adapter Usage:
 *
 * The CloudflareAgentsSDKAdapter converts Agents SDK method calls
 * (onChatMessage, setState, etc.) into AG-UI protocol events automatically.
 *
 * ## Configuration Options:
 *
 * ```typescript
 * const adapter = new CloudflareAgentsSDKAdapter({
 *   agent,              // Your Agents SDK agent instance
 *   syncState: false,   // Whether to auto-sync state via STATE_SNAPSHOT events
 *   trackSQL: false,    // Whether to track SQL operations (if your agent uses them)
 * });
 * ```
 *
 * ## When to Use This Adapter:
 *
 * - Migrating from pure Cloudflare Agents SDK to AG-UI
 * - Need to maintain compatibility with existing Agents SDK code
 * - Want to gradually adopt AG-UI protocol features
 *
 * @see tool_based_generative_ui/index.ts for the standard CloudflareAgent approach
 */

import { Request, Response } from "express";
import { CloudflareAgentsSDKAdapter } from "@ag-ui/cloudflare";
import { getToolBasedGenerativeUiAgent } from "./agent.js";

export async function toolBasedGenerativeUiSDKHandler(req: Request, res: Response) {
  try {
    const { messages, context, threadId, runId } = req.body;

    if (!messages || !Array.isArray(messages)) {
      res.status(400).json({ error: "Missing messages array" });
      return;
    }

    const finalThreadId = threadId || `thread-${Date.now()}`;
    const finalRunId = runId || `run-${Date.now()}-${Math.random().toString(36).substring(7)}`;

    const agent = getToolBasedGenerativeUiAgent();

    const adapter = new CloudflareAgentsSDKAdapter({
      agent,
      syncState: false,
      trackSQL: false,
    });

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    try {
      const executionContext = {
        threadId: finalThreadId,
        runId: finalRunId,
        ...context,
      };

      for await (const event of adapter.execute(messages, executionContext)) {
        // Add threadId to event data for SSE stream (CopilotKit/Dojo requirement)
        const eventWithThread = { ...event, threadId: finalThreadId };
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(eventWithThread)}\n\n`);
      }

      res.end();
    } catch (error) {
      const errorEvent = {
        type: "RUN_ERROR",
        message: error instanceof Error ? error.message : "Unknown error",
        threadId: finalThreadId,
        timestamp: Date.now(),
      };
      res.write(
        `event: RUN_ERROR\ndata: ${JSON.stringify(errorEvent)}\n\n`
      );
      res.end();
    }
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

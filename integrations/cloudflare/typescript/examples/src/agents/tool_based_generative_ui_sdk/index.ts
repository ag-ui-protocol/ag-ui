/**
 * Tool-Based Generative UI (Agents SDK version)
 * Uses Cloudflare Agents SDK with CloudflareAgentsSDKAdapter
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
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }

      res.end();
    } catch (error) {
      res.write(
        `data: ${JSON.stringify({
          type: "RUN_ERROR",
          data: {
            message: error instanceof Error ? error.message : "Unknown error",
          },
        })}\n\n`
      );
      res.end();
    }
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

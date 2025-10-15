import { CloudflareAGUIAdapter } from "@ag-ui/cloudflare";
import type { AGUIEvent } from "@ag-ui/core";
import type { Request, Response } from "express";

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken = process.env.CLOUDFLARE_API_TOKEN;

if (!accountId || !apiToken) {
  console.error(
    "Missing CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN environment variables"
  );
  process.exit(1);
}

export async function agenticChatHandler(req: Request, res: Response) {
  const { messages, context } = req.body;

  const adapter = new CloudflareAGUIAdapter({
    accountId,
    apiToken,
    model: "@cf/meta/llama-3.1-8b-instruct",
  });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  try {
    for await (const event of adapter.execute(messages, context)) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
    res.end();
  } catch (error) {
    console.error("Error in agentic_chat:", error);
    const errorEvent: AGUIEvent = {
      type: "ERROR",
      runId: "error",
      timestamp: new Date().toISOString(),
      data: {
        message: error instanceof Error ? error.message : "Unknown error",
      },
    };
    res.write(`data: ${JSON.stringify(errorEvent)}\n\n`);
    res.end();
  }
}

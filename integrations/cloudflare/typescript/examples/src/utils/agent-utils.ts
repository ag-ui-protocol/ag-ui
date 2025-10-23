/**
 * Shared utilities for Cloudflare agent handlers
 * Reduces code duplication across all agent implementations
 */

import type { Request, Response } from "express";
import type { BaseEvent } from "@ag-ui/core";

/**
 * Extract or generate a threadId from the request
 * Checks headers first, then falls back to generating a new one
 */
export function getOrCreateThreadId(req: Request): string {
  return (
    (req.headers["x-thread-id"] as string) ||
    `thread-${Date.now()}-${Math.random().toString(36).substring(7)}`
  );
}

/**
 * Generate a unique runId
 */
export function generateRunId(): string {
  return `run-${Date.now()}-${Math.random().toString(36).substring(7)}`;
}

/**
 * Add threadId to an AG-UI event
 * Required for CopilotKit/Dojo conversation tracking
 */
export function addThreadIdToEvent(event: BaseEvent, threadId: string): BaseEvent & { threadId: string } {
  return { ...event, threadId } as BaseEvent & { threadId: string };
}

/**
 * Set standard SSE (Server-Sent Events) headers
 * Used by all streaming agent endpoints
 */
export function setSSEHeaders(res: Response): void {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // Disable nginx buffering
}

/**
 * Create a standardized error handler for SSE streams
 * Ensures error events are properly formatted and sent
 */
export function createSSEErrorHandler(
  res: Response,
  threadId: string,
  options?: { agentType?: string; runId?: string }
) {
  return (error: unknown) => {
    // Enhanced error logging with full context
    console.error("Agent execution error:", {
      agentType: options?.agentType || "unknown",
      threadId,
      runId: options?.runId,
      error: error instanceof Error ? {
        message: error.message,
        stack: error.stack,
        name: error.name,
      } : error,
      timestamp: new Date().toISOString(),
    });

    const errorEvent = {
      type: "RUN_ERROR",
      message: error instanceof Error ? error.message : "Unknown error",
      threadId,
      runId: options?.runId,
      timestamp: Date.now(),
    };

    // Set headers if not already sent
    if (!res.headersSent) {
      setSSEHeaders(res);
    }

    res.write(`event: RUN_ERROR\ndata: ${JSON.stringify(errorEvent)}\n\n`);
    res.end();
  };
}

/**
 * Validate request has required messages array
 */
export function validateMessagesRequest(req: Request, res: Response): boolean {
  const { messages } = req.body;

  if (!messages || !Array.isArray(messages)) {
    res.status(400).json({
      error: "Missing or invalid 'messages' array in request body"
    });
    return false;
  }

  return true;
}

/**
 * Create standard AG-UI input object from request
 */
export function createAgentInput(req: Request) {
  const { messages, context, tools } = req.body;
  const threadId = getOrCreateThreadId(req);
  const runId = generateRunId();

  return {
    threadId,
    runId,
    messages,
    tools: tools || [],
    context: context ? [{ description: "Request context", value: JSON.stringify(context) }] : [],
    state: {},
    forwardedProps: {},
  };
}

/**
 * Write an event to SSE stream with proper formatting
 */
export function writeSSEEvent(res: Response, event: BaseEvent, threadId: string): void {
  const eventWithThread = addThreadIdToEvent(event, threadId);
  res.write(`event: ${event.type}\ndata: ${JSON.stringify(eventWithThread)}\n\n`);
}

/**
 * Handle client disconnect cleanup
 */
export function setupClientDisconnectHandler(req: Request, cleanup?: () => void): void {
  req.on("close", () => {
    if (cleanup) {
      cleanup();
    }
  });
}

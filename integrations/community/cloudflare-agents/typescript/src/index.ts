/**
 * @ag-ui/cloudflare-agents
 *
 * AG-UI integration for Cloudflare Agents
 *
 * - Client: Connect to deployed Cloudflare Agents from AG-UI clients
 * - Adapter: Convert Vercel AI SDK streams to AG-UI events
 * - Helpers: SSE/NDJSON streaming utilities
 *
 * @packageDocumentation
 */

// Client-side: Connect to deployed Cloudflare Agents
export {
  CloudflareAgentsClient,
  type CloudflareAgentsClientConfig,
} from "./client";

// Adapter for converting AI SDK streams to AG-UI events
export { AgentsToAGUIAdapter } from "./adapter";

// Response helpers for SSE/NDJSON streaming
export { createSSEResponse, createNDJSONResponse } from "./helpers";

// Re-export AG-UI types for convenience
export {
  EventType,
  type AgentConfig,
  type BaseEvent,
  type Message,
  type MessagesSnapshotEvent,
  type RunFinishedEvent,
  type RunStartedEvent,
  type RunAgentInput,
  type TextMessageChunkEvent,
  type ToolCallArgsEvent,
  type ToolCallEndEvent,
  type ToolCallStartEvent,
  type ToolCallResultEvent,
} from "@ag-ui/client";

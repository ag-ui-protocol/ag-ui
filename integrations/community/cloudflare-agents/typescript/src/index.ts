/**
 * @ag-ui/cloudflare-agents
 *
 * Complete AG-UI integration for Cloudflare Agents
 *
 * Provides both client-side and server-side integrations:
 * - Client: Connect to deployed Cloudflare Agents from AG-UI clients
 * - Server: Build Cloudflare Agents that emit AG-UI events
 *
 * @packageDocumentation
 */

// Client-side: Connect to deployed Cloudflare Agents
export {
  CloudflareAgentsClient,
  type CloudflareAgentsClientConfig,
} from "./client";

// Server-side: Build AG-UI-enabled Cloudflare Agents
export { AIChatAgentAGUI } from "./server";

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

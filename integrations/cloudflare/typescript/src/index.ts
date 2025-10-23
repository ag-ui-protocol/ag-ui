// Core imports for factory functions
import type { CloudflareAIConfig } from "./types";
import { CloudflareAGUIAdapter } from "./adapter";
import type { CloudflareAGUIAdapterOptions } from "./adapter";

// Core classes
export { CloudflareAGUIAdapter } from "./adapter";
export { CloudflareAIClient } from "./client";
export { CloudflareProviders } from "./providers";
export { CloudflareStreamParser } from "./stream-parser";

// CopilotKit compatibility - CloudflareAGUIAdapter already implements CopilotServiceAdapter
export { CloudflareAGUIAdapter as CopilotKitCloudflareAdapter } from "./adapter";

// HTTP Agent (re-exported from @ag-ui/client)
export { HttpAgent as CloudflareHttpAgent } from "@ag-ui/client";

// Cloudflare-specific agent
export { CloudflareAgent, type CloudflareAgentConfig } from "./cloudflare-agent";

// Infrastructure Support (NEW!)
export {
  handleCloudflareWorker,
  createCloudflareWorkerHandler,
  handleWebSocketConnection,
  type WorkersAdapterOptions,
  type WorkersEnv,
} from "./workers-adapter";

export {
  isBehindCloudflare,
  getClientIP,
  getProtocol,
  normalizeRequest,
  isWebSocketUpgrade,
  validateWebSocketUpgrade,
  getLoggingContext,
  createResponseHeaders,
  type CloudflareHeaders,
  type NormalizedRequest,
} from "./cloudflare-utils";

// Cloudflare Agents SDK Integration (NEW!)
export {
  CloudflareAgentsSDKAdapter,
  createAgentsSDKAdapter,
  createAgentsSDKWorkerHandler,
  type CloudflareAgentsSDKAgent,
  type AgentsSDKAdapterOptions,
} from "./agents-sdk-adapter";

export type {
  CloudflareAIConfig,
  CloudflareModel,
  CloudflareMessage,
  CloudflareCompletionOptions,
  CloudflareStreamChunk,
  Tool,
  ToolCall,
  ToolParameters,
  ModelCapabilities,
} from "./types";

export {
  CloudflareModelSchema,
  CloudflareMessageSchema,
  CloudflareAIConfigSchema,
  supportsToolCalling,
  validateMessages,
  validateConfig,
} from "./types";

export type { CloudflareAGUIAdapterOptions, AGUIProtocol, StreamableResult } from "./adapter";
export type { ProviderConfig } from "./providers";

// Re-export AG-UI core types
export { EventType, type BaseEvent } from "@ag-ui/core";

/**
 * Model constants for convenient access
 * These match the CloudflareModelSchema in types.ts
 *
 * @example
 * ```typescript
 * const adapter = new CloudflareAGUIAdapter({
 *   accountId: "...",
 *   apiToken: "...",
 *   model: CLOUDFLARE_MODELS.LLAMA_3_3_70B_FP8
 * });
 * ```
 */
export const CLOUDFLARE_MODELS = {
  // Llama 3.1 series (general purpose)
  LLAMA_3_1_8B: "@cf/meta/llama-3.1-8b-instruct" as const,
  LLAMA_3_1_70B: "@cf/meta/llama-3.1-70b-instruct" as const,

  // Llama 3.3 series (function calling support)
  LLAMA_3_3_70B_FP8: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" as const,

  // Llama 4 series (latest, function calling)
  LLAMA_4_SCOUT_17B: "@cf/meta/llama-4-scout-17b-16e-instruct" as const,

  // Mistral series
  MISTRAL_7B: "@cf/mistral/mistral-7b-instruct-v0.2" as const,
  MISTRAL_SMALL_24B: "@cf/mistralai/mistral-small-3.1-24b-instruct" as const,

  // Hermes series (function calling)
  HERMES_2_PRO_7B: "@cf/nousresearch/hermes-2-pro-mistral-7b" as const,

  // Legacy models (may be deprecated)
  LLAMA_2_7B: "@cf/meta/llama-2-7b-chat-int8" as const,
  GEMMA_7B: "@cf/google/gemma-7b-it" as const,
  QWEN_14B: "@cf/qwen/qwen1.5-14b-chat-awq" as const,
  PHI_2: "@cf/microsoft/phi-2" as const,
  DEEPSEEK_MATH_7B: "@cf/deepseek-ai/deepseek-math-7b-instruct" as const,
  DEEPSEEK_CODER_6B: "@cf/thebloke/deepseek-coder-6.7b-instruct-awq" as const,
} as const;

// Convenience factory functions

export function createCloudflareAdapter(config: CloudflareAIConfig) {
  return new CloudflareAGUIAdapter(config);
}

export function createCopilotKitCloudflareAdapter(options: CloudflareAGUIAdapterOptions) {
  return new CloudflareAGUIAdapter(options);
}

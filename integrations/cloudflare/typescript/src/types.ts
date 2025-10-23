import { z } from "zod";

/**
 * Cloudflare Workers AI Models
 * Updated to match available models as of January 2025
 */
export const CloudflareModelSchema = z.enum([
  // Llama 3.1 series (general purpose)
  "@cf/meta/llama-3.1-8b-instruct",
  "@cf/meta/llama-3.1-70b-instruct",

  // Llama 3.3 series (function calling support)
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",

  // Llama 4 series (latest, function calling)
  "@cf/meta/llama-4-scout-17b-16e-instruct",

  // Mistral series
  "@cf/mistral/mistral-7b-instruct-v0.2",
  "@cf/mistralai/mistral-small-3.1-24b-instruct",

  // Hermes series (function calling)
  "@cf/nousresearch/hermes-2-pro-mistral-7b",

  // Legacy models (may be deprecated)
  "@cf/meta/llama-2-7b-chat-int8",
  "@cf/google/gemma-7b-it",
  "@cf/qwen/qwen1.5-14b-chat-awq",
  "@cf/microsoft/phi-2",
  "@cf/deepseek-ai/deepseek-math-7b-instruct",
  "@cf/thebloke/deepseek-coder-6.7b-instruct-awq",
]);

export type CloudflareModel = z.infer<typeof CloudflareModelSchema>;

/**
 * Zod schema for message validation
 */
export const CloudflareMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool", "function"]),
  content: z.string(),
  tool_calls: z.array(z.object({
    id: z.string(),
    type: z.literal("function"),
    function: z.object({
      name: z.string(),
      arguments: z.string(),
    }),
  })).optional(),
  tool_call_id: z.string().optional(),
  name: z.string().optional(),
});

/**
 * Zod schema for AI config validation
 */
export const CloudflareAIConfigSchema = z.object({
  accountId: z.string().min(1, "Account ID is required"),
  apiToken: z.string().min(1, "API Token is required"),
  model: CloudflareModelSchema.optional(),
  baseURL: z.string().url().optional(),
  gatewayId: z.string().optional(),
});

export interface CloudflareAIConfig {
  accountId: string;
  apiToken: string;
  model?: CloudflareModel;
  baseURL?: string;
  gatewayId?: string;
}

export interface CloudflareMessage {
  role: "system" | "user" | "assistant" | "tool" | "function";
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface CloudflareStreamChunk {
  response?: string;
  tool_calls?: ToolCall[];
  done?: boolean;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface CloudflareCompletionOptions {
  messages: CloudflareMessage[];
  model?: CloudflareModel;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stream?: boolean;
  tools?: Tool[];
  tool_choice?: "auto" | "none" | { type: "function"; function: { name: string } };
}

/**
 * JSON Schema type for tool parameters
 * Represents a JSON Schema object describing function parameters
 */
export interface ToolParameters {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
  [key: string]: unknown;
}

export interface Tool {
  type: "function";
  function: {
    name: string;
    description?: string;
    /** JSON Schema describing the function parameters */
    parameters?: ToolParameters | Record<string, unknown>;
  };
}

export interface ModelCapabilities {
  streaming: boolean;
  functionCalling: boolean;
  maxTokens: number;
  contextWindow: number;
}

/**
 * Check if a model supports function/tool calling
 */
export function supportsToolCalling(model: CloudflareModel): boolean {
  const toolCapableModels: CloudflareModel[] = [
    "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    "@cf/meta/llama-4-scout-17b-16e-instruct",
    "@cf/mistralai/mistral-small-3.1-24b-instruct",
    "@cf/nousresearch/hermes-2-pro-mistral-7b",
  ];
  return toolCapableModels.includes(model);
}

/**
 * Validate messages array with Zod
 */
export function validateMessages(messages: unknown[]): CloudflareMessage[] {
  return messages.map((msg) => CloudflareMessageSchema.parse(msg));
}

/**
 * Validate AI config with Zod
 */
export function validateConfig(config: unknown): CloudflareAIConfig {
  return CloudflareAIConfigSchema.parse(config);
}

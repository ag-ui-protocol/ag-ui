import { z } from "zod";

export const CloudflareModelSchema = z.enum([
  "@cf/meta/llama-3.1-8b-instruct",
  "@cf/meta/llama-3.1-70b-instruct",
  "@cf/meta/llama-3.3-70b-instruct",
  "@cf/meta/llama-2-7b-chat-int8",
  "@cf/mistral/mistral-7b-instruct-v0.2",
  "@cf/google/gemma-7b-it",
  "@cf/qwen/qwen1.5-14b-chat-awq",
  "@cf/microsoft/phi-2",
  "@cf/deepseek-ai/deepseek-math-7b-instruct",
  "@cf/thebloke/deepseek-coder-6.7b-instruct-awq",
]);

export type CloudflareModel = z.infer<typeof CloudflareModelSchema>;

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

export interface Tool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, any>;
  };
}

export interface ModelCapabilities {
  streaming: boolean;
  functionCalling: boolean;
  maxTokens: number;
  contextWindow: number;
}

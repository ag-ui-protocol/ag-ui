import {
  CloudflareAIConfig,
  CloudflareCompletionOptions,
  CloudflareStreamChunk,
  CloudflareMessage,
  CloudflareModel,
  ToolCall,
  validateConfig,
} from "./types";
import { CloudflareStreamParser } from "./stream-parser";

// Default model to use as fallback
const DEFAULT_MODEL: CloudflareModel = "@cf/meta/llama-3.1-8b-instruct";

// API response types
interface CloudflareAPIResponse {
  result?: {
    response?: string;
    tool_calls?: ToolCall[];
    usage?: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
    };
  };
  response?: string;
  tool_calls?: ToolCall[];
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface ModelListResponse {
  result?: {
    models?: string[];
  };
  models?: string[];
}

interface RetryOptions {
  maxRetries?: number;
  baseDelay?: number;
  maxDelay?: number;
  retryableStatusCodes?: number[];
}

export class CloudflareAIClient {
  private config: CloudflareAIConfig;
  private baseURL: string;
  private headers: Record<string, string>;
  private retryOptions: Required<RetryOptions>;

  constructor(config: CloudflareAIConfig, retryOptions?: RetryOptions) {
    // ✅ Validate configuration with Zod schema
    // This catches invalid configs early and provides clear error messages
    this.config = validateConfig(config);

    if (this.config.gatewayId) {
      this.baseURL =
        this.config.baseURL ||
        `https://gateway.ai.cloudflare.com/v1/${this.config.accountId}/${this.config.gatewayId}/workers-ai/v1`;
    } else {
      this.baseURL =
        this.config.baseURL || `https://api.cloudflare.com/client/v4/accounts/${this.config.accountId}/ai/v1`;
    }

    this.headers = {
      Authorization: `Bearer ${this.config.apiToken}`,
      "Content-Type": "application/json",
    };

    // Default retry configuration
    this.retryOptions = {
      maxRetries: retryOptions?.maxRetries ?? 3,
      baseDelay: retryOptions?.baseDelay ?? 1000,
      maxDelay: retryOptions?.maxDelay ?? 10000,
      retryableStatusCodes: retryOptions?.retryableStatusCodes ?? [408, 429, 500, 502, 503, 504],
    };
  }

  async complete(options: CloudflareCompletionOptions): Promise<CloudflareMessage> {
    const response = await this.makeRequest(options);

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Cloudflare AI error: ${error}`);
    }

    const data: CloudflareAPIResponse = await response.json();
    return {
      role: "assistant",
      content: data.result?.response || data.response || "",
      tool_calls: data.result?.tool_calls || data.tool_calls,
    };
  }

  async *streamComplete(
    options: CloudflareCompletionOptions,
  ): AsyncGenerator<CloudflareStreamChunk> {
    const streamOptions = { ...options, stream: true };
    const response = await this.makeRequest(streamOptions);

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Cloudflare AI error: ${error}`);
    }

    // Check if response is streaming or not
    const contentType = response.headers.get("content-type");

    if (contentType?.includes("text/event-stream")) {
      // SSE streaming response
      if (!response.body) {
        throw new Error("No response body from Cloudflare AI");
      }
      const parser = new CloudflareStreamParser();
      yield* parser.parseStream(response.body);
    } else {
      // Non-streaming JSON response
      const data: CloudflareAPIResponse = await response.json();

      if (data.choices) {
        // OpenAI-compatible format (from /chat/completions endpoint)
        for (const choice of data.choices) {
          if (choice.message?.content) {
            yield { response: choice.message.content, done: false };
          }
        }
        yield { done: true, usage: data.usage };
      } else if (data.result) {
        // Cloudflare Workers AI format (from /ai/run endpoint)
        const content = data.result.response || "";
        if (content) {
          yield { response: content, done: false };
        }
        yield {
          done: true,
          usage: data.result.usage || this.estimateTokens(content),
        };
      } else {
        console.warn("Unexpected response format:", data);
        yield { done: true };
      }
    }
  }

  private async makeRequest(options: CloudflareCompletionOptions): Promise<globalThis.Response> {
    const model = options.model || this.config.model || DEFAULT_MODEL;
    const endpoint = `${this.baseURL}/chat/completions`;

    const body: Record<string, any> = {
      model,
      messages: options.messages,
      temperature: options.temperature,
      max_tokens: options.max_tokens,
      top_p: options.top_p,
      frequency_penalty: options.frequency_penalty,
      presence_penalty: options.presence_penalty,
      stream: options.stream || false,
      tools: options.tools,
      tool_choice: options.tool_choice,
    };

    // Remove undefined values - cleaner approach
    const cleanBody = Object.fromEntries(
      Object.entries(body).filter(([_, value]) => value !== undefined)
    );

    // Use retry logic for non-streaming requests
    if (!options.stream) {
      return this.fetchWithRetry(endpoint, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify(cleanBody),
      });
    }

    // For streaming, don't retry (would duplicate stream)
    return fetch(endpoint, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(cleanBody),
    });
  }

  /**
   * Fetch with exponential backoff retry logic
   */
  private async fetchWithRetry(
    url: string,
    init: RequestInit,
    attempt = 0
  ): Promise<globalThis.Response> {
    try {
      const response = await fetch(url, init);

      // Check if we should retry based on status code
      if (
        !response.ok &&
        attempt < this.retryOptions.maxRetries &&
        this.retryOptions.retryableStatusCodes.includes(response.status)
      ) {
        const delay = this.calculateBackoff(attempt);
        console.warn(
          `Request failed with status ${response.status}. Retrying in ${delay}ms (attempt ${attempt + 1}/${this.retryOptions.maxRetries})`
        );
        await this.sleep(delay);
        return this.fetchWithRetry(url, init, attempt + 1);
      }

      return response;
    } catch (error) {
      // Network errors - retry if we have attempts left
      if (attempt < this.retryOptions.maxRetries) {
        const delay = this.calculateBackoff(attempt);
        console.warn(
          `Network error: ${error}. Retrying in ${delay}ms (attempt ${attempt + 1}/${this.retryOptions.maxRetries})`
        );
        await this.sleep(delay);
        return this.fetchWithRetry(url, init, attempt + 1);
      }

      // No more retries - throw the error
      throw error;
    }
  }

  /**
   * Calculate exponential backoff delay with jitter
   */
  private calculateBackoff(attempt: number): number {
    const exponentialDelay = this.retryOptions.baseDelay * Math.pow(2, attempt);
    const jitter = Math.random() * 0.3 * exponentialDelay; // Add 0-30% jitter
    return Math.min(exponentialDelay + jitter, this.retryOptions.maxDelay);
  }

  /**
   * Sleep helper for retry delays
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Estimate token count from text
   * Uses rough approximation: 1 token ≈ 4 characters for English text
   */
  private estimateTokens(text: string): {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  } {
    const estimatedTokens = Math.ceil(text.length / 4);
    return {
      prompt_tokens: 0,
      completion_tokens: estimatedTokens,
      total_tokens: estimatedTokens,
    };
  }

  async listModels(): Promise<string[]> {
    const response = await fetch(`${this.baseURL}/models`, {
      headers: this.headers,
    });

    if (!response.ok) {
      throw new Error(`Failed to list models: ${response.statusText}`);
    }

    const data: ModelListResponse = await response.json();
    return data.result?.models || data.models || [];
  }

  getModelCapabilities(model: string): {
    streaming: boolean;
    functionCalling: boolean;
    maxTokens: number;
    contextWindow: number;
  } {
    const capabilities: Record<string, {
      streaming: boolean;
      functionCalling: boolean;
      maxTokens: number;
      contextWindow: number;
    }> = {
      "@cf/meta/llama-3.3-70b-instruct-fp8-fast": {
        streaming: true,
        functionCalling: true,
        maxTokens: 4096,
        contextWindow: 128000,
      },
      "@cf/meta/llama-4-scout-17b-16e-instruct": {
        streaming: true,
        functionCalling: true,
        maxTokens: 4096,
        contextWindow: 128000,
      },
      "@cf/mistralai/mistral-small-3.1-24b-instruct": {
        streaming: true,
        functionCalling: true,
        maxTokens: 8192,
        contextWindow: 32768,
      },
      "@cf/nousresearch/hermes-2-pro-mistral-7b": {
        streaming: true,
        functionCalling: true,
        maxTokens: 4096,
        contextWindow: 32768,
      },
      "@cf/meta/llama-3.1-70b-instruct": {
        streaming: true,
        functionCalling: false,
        maxTokens: 4096,
        contextWindow: 128000,
      },
      "@cf/meta/llama-3.1-8b-instruct": {
        streaming: true,
        functionCalling: false,
        maxTokens: 2048,
        contextWindow: 128000,
      },
      "@cf/mistral/mistral-7b-instruct-v0.2": {
        streaming: true,
        functionCalling: false,
        maxTokens: 2048,
        contextWindow: 32768,
      },
    };

    return capabilities[model] || {
      streaming: true,
      functionCalling: false,
      maxTokens: 2048,
      contextWindow: 4096,
    };
  }
}

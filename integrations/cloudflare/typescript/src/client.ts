import {
  CloudflareAIConfig,
  CloudflareCompletionOptions,
  CloudflareStreamChunk,
  CloudflareMessage,
} from "./types";
import { CloudflareStreamParser } from "./stream-parser";

export class CloudflareAIClient {
  private config: CloudflareAIConfig;
  private baseURL: string;
  private headers: Record<string, string>;

  constructor(config: CloudflareAIConfig) {
    this.config = config;

    if (config.gatewayId) {
      this.baseURL =
        config.baseURL ||
        `https://gateway.ai.cloudflare.com/v1/${config.accountId}/${config.gatewayId}/workers-ai/v1`;
    } else {
      this.baseURL =
        config.baseURL || `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/ai/v1`;
    }

    this.headers = {
      Authorization: `Bearer ${config.apiToken}`,
      "Content-Type": "application/json",
    };
  }

  async complete(options: CloudflareCompletionOptions): Promise<CloudflareMessage> {
    const response = await this.makeRequest(options);

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Cloudflare AI error: ${error}`);
    }

    const data = (await response.json()) as any;
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
      const data = (await response.json()) as any;

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
          usage: data.result.usage || {
            prompt_tokens: 0,
            completion_tokens: content.length / 4, // Estimate
            total_tokens: content.length / 4,
          },
        };
      } else {
        console.warn("Unexpected response format:", data);
        yield { done: true };
      }
    }
  }

  private async makeRequest(options: CloudflareCompletionOptions): Promise<globalThis.Response> {
    const model = options.model || this.config.model || "@cf/meta/llama-3.1-8b-instruct";
    const endpoint = `${this.baseURL}/chat/completions`;

    const body = {
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

    // Remove undefined values
    Object.keys(body).forEach((key) => {
      if ((body as any)[key] === undefined) {
        delete (body as any)[key];
      }
    });

    return fetch(endpoint, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(body),
    });
  }

  async listModels(): Promise<string[]> {
    const response = await fetch(`${this.baseURL}/models`, {
      headers: this.headers,
    });

    if (!response.ok) {
      throw new Error(`Failed to list models: ${response.statusText}`);
    }

    const data = (await response.json()) as any;
    return data.result?.models || data.models || [];
  }

  getModelCapabilities(model: string) {
    const capabilities = {
      "@cf/meta/llama-3.3-70b-instruct": {
        streaming: true,
        functionCalling: true,
        maxTokens: 4096,
        contextWindow: 128000,
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

    return (
      (capabilities as any)[model] || {
        streaming: true,
        functionCalling: false,
        maxTokens: 2048,
        contextWindow: 4096,
      }
    );
  }
}

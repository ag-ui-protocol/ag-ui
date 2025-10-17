import { createParser, ParsedEvent, ReconnectInterval } from "eventsource-parser";
import { CloudflareStreamChunk } from "./types";

export class CloudflareStreamParser {
  private parser;
  private buffer: string = "";

  constructor() {
    this.parser = createParser(this.onParse.bind(this));
  }

  private onParse(event: ParsedEvent | ReconnectInterval) {
    if (event.type === "event") {
      try {
        const data = JSON.parse(event.data);
        return data as CloudflareStreamChunk;
      } catch (error) {
        console.error("Failed to parse stream chunk:", error);
      }
    }
  }

  async *parseStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<CloudflareStreamChunk> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split("\n");

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6).trim();
            if (data === "[DONE]") {
              // Signal completion
              yield { done: true };
              return;
            }
            if (data) {
              try {
                const parsed = JSON.parse(data);

                // Handle OpenAI streaming format
                if (parsed.choices?.[0]?.delta) {
                  const delta = parsed.choices[0].delta;
                  if (delta.content) {
                    yield { response: delta.content, done: false };
                  }
                  if (delta.tool_calls) {
                    yield { tool_calls: delta.tool_calls, done: false };
                  }
                } else if (parsed.response) {
                  // Handle Cloudflare format
                  yield { response: parsed.response, done: false };
                }

                // Check for completion
                if (parsed.choices?.[0]?.finish_reason) {
                  yield {
                    done: true,
                    usage: parsed.usage,
                  };
                }
              } catch (error) {
                // Handle partial JSON in buffer
                this.buffer += data;
                try {
                  const parsed = JSON.parse(this.buffer);
                  if (parsed.choices?.[0]?.delta?.content) {
                    yield { response: parsed.choices[0].delta.content, done: false };
                  }
                  this.buffer = "";
                } catch {
                  // Still incomplete, continue buffering
                }
              }
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  parseSSE(text: string): CloudflareStreamChunk[] {
    const chunks: CloudflareStreamChunk[] = [];
    const lines = text.split("\n");

    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const data = line.slice(6);
        if (data !== "[DONE]") {
          try {
            chunks.push(JSON.parse(data));
          } catch (error) {
            console.error("Failed to parse SSE chunk:", error);
          }
        }
      }
    }

    return chunks;
  }
}

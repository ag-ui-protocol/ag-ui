import { createParser, ParsedEvent, ReconnectInterval } from "eventsource-parser";
import { CloudflareStreamChunk } from "./types";

interface ToolCallAccumulator {
  id?: string;
  name?: string;
  args: string;
}

interface ToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

export class CloudflareStreamParser {
  private parser;
  private buffer: string = "";
  private toolCallAccumulators: Map<number, ToolCallAccumulator> = new Map();
  private readonly MAX_BUFFER_SIZE = 50000; // 50KB max buffer size
  private readonly MAX_TOOL_CALL_ARGS_SIZE = 100000; // 100KB max tool call args

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

  private isCompleteJSON(str: string): boolean {
    const trimmed = str.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return false;

    let depth = 0;
    for (const char of trimmed) {
      if (char === "{") depth++;
      else if (char === "}") depth--;
      if (depth < 0) return false;
    }
    return depth === 0;
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
              this.toolCallAccumulators.clear();
              yield { done: true };
              return;
            }
            if (data) {
              try {
                const parsed = JSON.parse(data);

                // Handle OpenAI streaming format
                if (parsed.choices?.[0]?.delta) {
                  const delta = parsed.choices[0].delta;

                  // Handle text content
                  if (delta.content) {
                    yield { response: delta.content, done: false };
                  }

                  // Handle tool call deltas (ACCUMULATE THEM!)
                  if (delta.tool_calls) {
                    for (const toolCallDelta of delta.tool_calls as ToolCallDelta[]) {
                      const index = toolCallDelta.index ?? 0;

                      // Get or create accumulator for this tool call
                      if (!this.toolCallAccumulators.has(index)) {
                        this.toolCallAccumulators.set(index, { args: "" });
                      }
                      const acc = this.toolCallAccumulators.get(index)!;

                      // Accumulate id, name, and arguments
                      if (toolCallDelta.id) acc.id = toolCallDelta.id;
                      if (toolCallDelta.function?.name) acc.name = toolCallDelta.function.name;
                      if (toolCallDelta.function?.arguments) {
                        const newArgs = acc.args + toolCallDelta.function.arguments;

                        // Prevent unbounded growth of tool call arguments
                        if (newArgs.length > this.MAX_TOOL_CALL_ARGS_SIZE) {
                          console.error(`Tool call arguments exceeded max size (${this.MAX_TOOL_CALL_ARGS_SIZE} bytes)`);
                          this.toolCallAccumulators.delete(index);
                          continue;
                        }

                        acc.args = newArgs;
                      }

                      // Check if we have a complete tool call
                      if (acc.name && acc.args && this.isCompleteJSON(acc.args)) {
                        try {
                          const args = acc.args.trim();
                          // Validate JSON before emitting so we do not drop malformed payloads
                          JSON.parse(args);

                          // Yield complete tool call
                          yield {
                            tool_calls: [{
                              id: acc.id || `tool-${index}`,
                              type: "function",
                              function: {
                                name: acc.name,
                                arguments: args,
                              },
                            }],
                            done: false,
                          };

                          // Clear accumulator
                          this.toolCallAccumulators.delete(index);
                        } catch (e) {
                          // JSON not valid yet, keep accumulating
                        }
                      }
                    }
                  }
                } else if (parsed.response) {
                  // Handle Cloudflare format
                  yield { response: parsed.response, done: false };
                }

                // Check for completion
                if (parsed.choices?.[0]?.finish_reason) {
                  this.toolCallAccumulators.clear();
                  yield {
                    done: true,
                    usage: parsed.usage,
                  };
                }
              } catch (error) {
                // Handle partial JSON in buffer
                const newBuffer = this.buffer + data;

                // Prevent unbounded buffer growth
                if (newBuffer.length > this.MAX_BUFFER_SIZE) {
                  console.error(`Stream buffer exceeded max size (${this.MAX_BUFFER_SIZE} bytes). Resetting buffer.`);
                  this.buffer = "";
                  continue;
                }

                this.buffer = newBuffer;
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

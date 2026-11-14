/**
 * Test helpers: real AI SDK `streamText` (v7 and v6) over mock models, and an
 * AG-UI client agent that runs the server code in process, so tests go
 * through the same verify/apply pipeline a real client uses.
 */
import { AbstractAgent, type BaseEvent, type RunAgentInput } from "@ag-ui/client";
import * as ai7 from "ai";
import * as test7 from "ai/test";
import * as ai6 from "ai-v6";
import * as test6 from "ai-v6/test";
import { from, type Observable } from "rxjs";

export type Chunk = Record<string, unknown> & { type: string };

export interface Sdk {
  name: string;
  ai: typeof ai7;
  /** A mock model that answers each call with the next list of chunks. */
  model(turns: Array<Chunk[] | ((options: any) => ReadableStream<Chunk>)>): MockModel;
}

export interface MockModel {
  /** The prompts the model received, one per call. */
  prompts: any[];
  calls: any[];
}

function makeSdk(name: string, ai: unknown, Mock: any, toStream: (chunks: Chunk[]) => ReadableStream<Chunk>): Sdk {
  return {
    name,
    ai: ai as typeof ai7,
    model(turns) {
      const prompts: any[] = [];
      const calls: any[] = [];
      let index = 0;
      const model = new Mock({
        provider: "mock-provider",
        modelId: "mock-model",
        doStream: async (options: any) => {
          prompts.push(options.prompt);
          calls.push(options);
          const turn = turns[Math.min(index++, turns.length - 1)]!;
          return { stream: typeof turn === "function" ? turn(options) : toStream(turn) };
        },
      });
      return Object.assign(model, { prompts, calls });
    },
  };
}

export const SDKS: Sdk[] = [
  makeSdk("ai@7", ai7, test7.MockLanguageModelV4, (c) => test7.convertArrayToReadableStream(c)),
  makeSdk("ai@6", ai6, test6.MockLanguageModelV3, (c) => test6.convertArrayToReadableStream(c) as any),
];

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

export const chunks = {
  start: (): Chunk => ({ type: "stream-start", warnings: [] }),
  text: (id: string, ...deltas: string[]): Chunk[] => [
    { type: "text-start", id },
    ...deltas.map((delta) => ({ type: "text-delta", id, delta })),
    { type: "text-end", id },
  ],
  reasoning: (id: string, text: string, providerMetadata?: Record<string, unknown>): Chunk[] => [
    { type: "reasoning-start", id },
    { type: "reasoning-delta", id, delta: text },
    { type: "reasoning-end", id, ...(providerMetadata && { providerMetadata }) },
  ],
  toolCall: (toolCallId: string, toolName: string, input: unknown, providerMetadata?: Record<string, unknown>): Chunk => ({
    type: "tool-call",
    toolCallId,
    toolName,
    input: JSON.stringify(input),
    ...(providerMetadata && { providerMetadata }),
  }),
  streamedToolCall: (toolCallId: string, toolName: string, input: unknown): Chunk[] => {
    const json = JSON.stringify(input);
    const half = Math.ceil(json.length / 2);
    return [
      { type: "tool-input-start", id: toolCallId, toolName },
      { type: "tool-input-delta", id: toolCallId, delta: json.slice(0, half) },
      { type: "tool-input-delta", id: toolCallId, delta: json.slice(half) },
      { type: "tool-input-end", id: toolCallId },
      { type: "tool-call", toolCallId, toolName, input: json },
    ];
  },
  finish: (reason: "stop" | "tool-calls" = "stop"): Chunk => ({
    type: "finish",
    finishReason: { unified: reason, raw: reason },
    usage,
  }),
};

/** A whole model turn: stream start, the given chunks, finish. */
export function turn(...parts: Array<Chunk | Chunk[]>): Chunk[] {
  const body = parts.flat();
  const toolCalls = body.some((chunk) => chunk.type === "tool-call");
  return [chunks.start(), ...body, chunks.finish(toolCalls ? "tool-calls" : "stop")];
}

/** An AG-UI client agent whose runs execute `serve` in process. */
export class LocalAgent extends AbstractAgent {
  constructor(private readonly serve: (input: RunAgentInput) => AsyncIterable<BaseEvent>) {
    super({ threadId: "thread-1" });
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    return from(this.serve(input));
  }
}

export async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const event of events) result.push(event);
  return result;
}

import {
  EventType,
  type BaseEvent,
  type RunAgentInput,
} from "@ag-ui/client";
import { Observable, firstValueFrom, toArray } from "rxjs";
import type { Subscriber } from "rxjs";
import { MockLanguageModelV3, convertArrayToReadableStream } from "ai/test";
import { StreamHandler } from "../stream-handler";

export function makeInput(overrides: Partial<RunAgentInput> = {}): RunAgentInput {
  return {
    threadId: "thread-1",
    runId: "run-1",
    messages: [],
    tools: [],
    context: [],
    forwardedProps: {},
    state: undefined,
    ...overrides,
  } as RunAgentInput;
}

/**
 * Drives a StreamHandler against an async iterable of stream parts and
 * returns the full event sequence emitted to the rxjs Subscriber.
 */
export function collectEvents(
  stream: AsyncIterable<unknown>,
  input: Partial<RunAgentInput> = {},
): Promise<BaseEvent[]> {
  return firstValueFrom(
    new Observable<BaseEvent>((subscriber: Subscriber<BaseEvent>) => {
      const handler = new StreamHandler(makeInput(input), subscriber);
      handler
        .process(stream as AsyncIterable<never>)
        .catch((err) => {
          if (!subscriber.closed) subscriber.error(err);
        });
    }).pipe(toArray()),
  );
}

/**
 * Build a MockLanguageModelV3 whose doStream() returns the supplied parts.
 * If `parts` is a function it is treated as a multi-call factory: call N
 * receives `parts(N)`.
 */
export function makeMockModel(
  parts: unknown[] | ((callCount: number) => unknown[]),
): MockLanguageModelV3 {
  let callCount = 0;
  return new MockLanguageModelV3({
    doStream: async () => {
      callCount += 1;
      const list = typeof parts === "function" ? parts(callCount) : parts;
      return {
        // The mock accepts any LanguageModelV3 stream parts; the structural
        // shape is enforced at runtime by streamText.
        stream: convertArrayToReadableStream(list as never[]),
      } as never;
    },
  });
}

/** Return events of a given EventType, narrowed to a usable shape. */
export function eventsOfType<E extends BaseEvent = BaseEvent>(
  events: BaseEvent[],
  type: EventType,
): E[] {
  return events.filter((e) => e.type === type) as E[];
}

/** Convenience: stream-start + response-metadata + finish wrapper. */
export const streamStart = { type: "stream-start" as const, warnings: [] };
export const responseMetadata = (id = "test-1") => ({
  type: "response-metadata" as const,
  id,
  modelId: "mock",
  timestamp: new Date(),
});
export const finishStop = (
  usage: { inputTokens: number; outputTokens: number; totalTokens: number } = {
    inputTokens: 5,
    outputTokens: 3,
    totalTokens: 8,
  },
) => ({ type: "finish" as const, finishReason: "stop" as const, usage });
export const finishToolCalls = (
  usage: { inputTokens: number; outputTokens: number; totalTokens: number } = {
    inputTokens: 5,
    outputTokens: 3,
    totalTokens: 8,
  },
) => ({ type: "finish" as const, finishReason: "tool-calls" as const, usage });

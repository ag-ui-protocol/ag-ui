import { describe, expect, it } from "vitest";
import {
  EventType,
  verifyEvents,
  type AssistantMessage,
  type MessagesSnapshotEvent,
  type RunErrorEvent,
  type RunFinishedEvent,
  type ToolCallResultEvent,
  type ToolMessage,
} from "@ag-ui/client";
import { jsonSchema, stepCountIs, streamText, tool } from "ai";
import { firstValueFrom, from, Observable, Subscriber, toArray } from "rxjs";
import {
  collectEvents,
  eventsOfType,
  finishStop,
  finishToolCalls,
  fsFinish,
  fsFinishStep,
  makeInput,
  makeMockModel,
  responseMetadata,
  streamStart,
  type FullStreamPart,
} from "./helpers";
import { StreamHandler } from "../stream-handler";
import type { BaseEvent } from "@ag-ui/client";

const weatherTool = {
  get_weather: tool({
    description: "Get weather for a city",
    inputSchema: jsonSchema<{ city: string }>({
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    }),
    execute: async ({ city }: { city: string }) => ({ city, ok: true }),
  }),
};

describe("StreamHandler — error & cancel handling", () => {
  it("treats a stream-internal `error` part as terminal: emits RUN_ERROR and completes (no RUN_FINISHED, no MESSAGES_SNAPSHOT)", async () => {
    const model = makeMockModel([
      streamStart,
      responseMetadata(),
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "Partial " },
      { type: "text-delta", id: "t1", delta: "text" },
      { type: "text-end", id: "t1" },
      { type: "error", error: new Error("simulated provider error") },
      {
        type: "finish",
        finishReason: { unified: "error", raw: "error" },
        usage: {
          inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 2, text: 2, reasoning: undefined },
        },
      },
    ]);
    const events = await collectEvents(streamText({ model, prompt: "hi" }).fullStream);

    const errors = eventsOfType<RunErrorEvent>(events, EventType.RUN_ERROR);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("simulated");
    expect(errors[0].code).toBe("stream_error_part");

    // RUN_ERROR is terminal — no RUN_FINISHED, no MESSAGES_SNAPSHOT.
    expect(events.find((e) => e.type === EventType.RUN_FINISHED)).toBeUndefined();
    expect(events.find((e) => e.type === EventType.MESSAGES_SNAPSHOT)).toBeUndefined();
    // Last event is RUN_ERROR.
    expect(events[events.length - 1].type).toBe(EventType.RUN_ERROR);
  });

  it("invalid tool-call does NOT produce a duplicate TOOL_CALL_RESULT (lets v7's tool-error path emit it once)", async () => {
    const model = makeMockModel([
      streamStart,
      responseMetadata(),
      { type: "tool-input-start", id: "tc-bad", toolName: "get_weather" },
      { type: "tool-input-delta", id: "tc-bad", delta: '{"city":"Tokyo"' },
      { type: "tool-input-end", id: "tc-bad" },
      // input string is malformed (missing closing brace) — AI SDK emits
      // tool-call(invalid:true) followed by an automatic tool-error.
      {
        type: "tool-call",
        toolCallId: "tc-bad",
        toolName: "get_weather",
        input: '{"city":"Tokyo"',
      },
      finishToolCalls(),
    ]);

    const events = await collectEvents(
      streamText({ model, prompt: "Weather?", tools: weatherTool }).fullStream,
    );

    const results = eventsOfType<ToolCallResultEvent>(events, EventType.TOOL_CALL_RESULT);
    expect(results).toHaveLength(1);
    expect(results[0].toolCallId).toBe("tc-bad");
    expect(events[events.length - 1].type).toBe(EventType.RUN_FINISHED);
  });

  it("tool-error pushes a ToolMessage with `error` field and emits TOOL_CALL_RESULT", async () => {
    async function* parts(): AsyncIterable<FullStreamPart> {
      yield { type: "start" };
      yield { type: "start-step", request: {}, warnings: [] };
      yield { type: "tool-input-start", id: "tc-err", toolName: "broken" };
      yield { type: "tool-input-end", id: "tc-err" };
      yield {
        type: "tool-call",
        toolCallId: "tc-err",
        toolName: "broken",
        input: { x: 1 },
        dynamic: true,
      };
      yield {
        type: "tool-error",
        toolCallId: "tc-err",
        toolName: "broken",
        input: { x: 1 },
        error: new Error("boom"),
        dynamic: true,
      };
      yield fsFinishStep();
      yield fsFinish();
    }

    const events = await collectEvents(parts());
    const results = eventsOfType<ToolCallResultEvent>(events, EventType.TOOL_CALL_RESULT);
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("boom");

    const snap = events.find((e) => e.type === EventType.MESSAGES_SNAPSHOT) as MessagesSnapshotEvent;
    const toolMsg = snap.messages.find((m) => m.role === "tool") as ToolMessage;
    expect(toolMsg.error).toBe("boom");
  });

  it("synthesizes a missing TOOL_CALL_RESULT in the cleanup phase when none arrived", async () => {
    // Stream has a tool-call but no tool-result and no tool-error follow-up.
    async function* parts(): AsyncIterable<FullStreamPart> {
      yield { type: "start" };
      yield { type: "start-step", request: {}, warnings: [] };
      yield { type: "tool-input-start", id: "tc-orphan", toolName: "noop" };
      yield { type: "tool-input-end", id: "tc-orphan" };
      yield {
        type: "tool-call",
        toolCallId: "tc-orphan",
        toolName: "noop",
        input: {},
        dynamic: true,
      };
      yield fsFinishStep();
      yield fsFinish();
    }

    const events = await collectEvents(parts());
    const results = eventsOfType<ToolCallResultEvent>(events, EventType.TOOL_CALL_RESULT);
    expect(results).toHaveLength(1);
    expect(results[0].toolCallId).toBe("tc-orphan");
    expect(results[0].content).toBe("Tool call missing result");

    const snap = events.find((e) => e.type === EventType.MESSAGES_SNAPSHOT) as MessagesSnapshotEvent;
    const toolMsg = snap.messages.find((m) => m.role === "tool") as ToolMessage;
    expect(toolMsg).toBeDefined();
    expect(toolMsg.toolCallId).toBe("tc-orphan");
  });

  it("does NOT synthesize a missing tool result when one was already provided", async () => {
    const model = makeMockModel((n) =>
      n === 1
        ? [
            streamStart,
            responseMetadata("s1"),
            { type: "tool-input-start", id: "tc-1", toolName: "get_weather" },
            { type: "tool-input-end", id: "tc-1" },
            {
              type: "tool-call",
              toolCallId: "tc-1",
              toolName: "get_weather",
              input: '{"city":"NYC"}',
            },
            finishToolCalls(),
          ]
        : [streamStart, responseMetadata("s2"), finishStop()],
    );

    const events = await collectEvents(
      streamText({
        model,
        prompt: "weather",
        tools: weatherTool,
        stopWhen: stepCountIs(2),
      }).fullStream,
    );
    const results = eventsOfType<ToolCallResultEvent>(events, EventType.TOOL_CALL_RESULT);
    expect(results).toHaveLength(1);
    expect(results[0].content).not.toContain("missing");
  });

  it("does NOT synthesize a missing tool result for tool calls already covered by input messages", async () => {
    // Drive the handler with a stream that contains an assistant tool-call
    // but the corresponding tool result is in the input messages already.
    async function* parts(): AsyncIterable<FullStreamPart> {
      yield { type: "start" };
      yield { type: "start-step", request: {}, warnings: [] };
      yield { type: "text-start", id: "t-final" };
      yield { type: "text-delta", id: "t-final", text: "ok" };
      yield { type: "text-end", id: "t-final" };
      yield fsFinishStep();
      yield fsFinish();
    }

    const events = await collectEvents(parts(), {
      messages: [
        { id: "u1", role: "user", content: "hi" },
        {
          id: "a1",
          role: "assistant",
          content: "I'll look it up",
          toolCalls: [
            {
              id: "tc-prev",
              type: "function",
              function: { name: "noop", arguments: "{}" },
            },
          ],
        },
        { id: "tm1", role: "tool", toolCallId: "tc-prev", content: "done" },
      ],
    });

    // No new TOOL_CALL_RESULT events should be emitted since the prior tool
    // result is already in the input messages.
    const results = eventsOfType<ToolCallResultEvent>(events, EventType.TOOL_CALL_RESULT);
    expect(results).toHaveLength(0);
  });

  it("treats an abortSignal stop as a cancellation: RUN_FINISHED { outcome: { type: 'cancelled' } }, no RUN_ERROR", async () => {
    // Deterministic timing: the stream blocks after the first delta until the
    // test signals (after observing TEXT_MESSAGE_CONTENT). No wall-clock racing.
    const abortController = new AbortController();
    let releaseStream!: () => void;
    const blockedUntilAbort = new Promise<void>((r) => {
      releaseStream = r;
    });

    const delayingModel = {
      specificationVersion: "v3",
      provider: "mock",
      modelId: "mock-1",
      doStream: async () => ({
        stream: new ReadableStream({
          async start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({
              type: "response-metadata",
              id: "abort-test",
              modelId: "mock",
              timestamp: new Date(),
            });
            controller.enqueue({ type: "text-start", id: "ta" });
            controller.enqueue({ type: "text-delta", id: "ta", delta: "Hello " });
            await blockedUntilAbort;
            controller.close();
          },
        }),
      }),
    };

    const result = streamText({
      model: delayingModel as never,
      prompt: "hi",
      abortSignal: abortController.signal,
    });

    const events: BaseEvent[] = [];
    await new Promise<void>((resolve) => {
      const observable = new Observable<BaseEvent>((subscriber: Subscriber<BaseEvent>) => {
        const handler = new StreamHandler(makeInput(), subscriber);
        handler.process(result.fullStream).catch(() => {});
      });
      observable.subscribe({
        next: (e) => {
          events.push(e);
          if (e.type === EventType.TEXT_MESSAGE_CONTENT && !abortController.signal.aborted) {
            abortController.abort();
            releaseStream();
          }
        },
        complete: () => resolve(),
        error: () => resolve(),
      });
    });

    // A user-requested stop is not a failure: protocol 1.0 models it as
    // RUN_FINISHED with a `cancelled` outcome, which is what clears a pending
    // interrupt and keeps UIs from showing an error banner for a deliberate stop.
    expect(eventsOfType<RunErrorEvent>(events, EventType.RUN_ERROR)).toHaveLength(0);
    const finished = eventsOfType<RunFinishedEvent>(events, EventType.RUN_FINISHED);
    expect(finished).toHaveLength(1);
    expect(finished[0].outcome).toEqual({ type: "cancelled" });
    expect(events[events.length - 1].type).toBe(EventType.RUN_FINISHED);
    // `totalUsage` only ever arrives on the terminal `finish` part, which an
    // aborted stream never emits — so a cancelled run reports no usage.
    expect(finished[0].usage).toBeUndefined();

    const idx = (type: EventType) => events.findIndex((e) => e.type === type);
    const finishedIdx = idx(EventType.RUN_FINISHED);
    // Everything the abort left open is closed BEFORE RUN_FINISHED, so the
    // sequence still passes client-side verification.
    expect(idx(EventType.TEXT_MESSAGE_END)).toBeGreaterThan(-1);
    expect(idx(EventType.TEXT_MESSAGE_END)).toBeLessThan(finishedIdx);
    expect(idx(EventType.STEP_FINISHED)).toBeGreaterThan(-1);
    expect(idx(EventType.STEP_FINISHED)).toBeLessThan(finishedIdx);

    // Partial content streamed before the stop is persisted, not discarded.
    const snapIdx = idx(EventType.MESSAGES_SNAPSHOT);
    expect(snapIdx).toBeGreaterThan(-1);
    expect(snapIdx).toBeLessThan(finishedIdx);
    const snap = events[snapIdx] as MessagesSnapshotEvent;
    const assistant = snap.messages.find((m) => m.role === "assistant") as AssistantMessage;
    expect(assistant.content).toBe("Hello ");

    await expect(
      firstValueFrom(from(events).pipe(verifyEvents(), toArray())),
    ).resolves.toHaveLength(events.length);
  });

  it("an `abort` part closes open reasoning/text/tool events and never synthesizes tool results", async () => {
    async function* parts(): AsyncIterable<FullStreamPart> {
      yield { type: "start" };
      yield { type: "start-step", request: {}, warnings: [] };
      yield { type: "text-start", id: "t1" };
      yield { type: "text-delta", id: "t1", text: "Partial" };
      yield { type: "tool-input-start", id: "tc-done", toolName: "noop" };
      yield { type: "tool-input-end", id: "tc-done" };
      yield {
        type: "tool-call",
        toolCallId: "tc-done",
        toolName: "noop",
        input: {},
        dynamic: true,
      };
      // Left open on purpose: args were still streaming when the stop landed.
      yield { type: "tool-input-start", id: "tc-open", toolName: "noop" };
      yield { type: "tool-input-delta", id: "tc-open", delta: '{"a":' };
      yield { type: "reasoning-start", id: "r1" };
      yield { type: "reasoning-delta", id: "r1", text: "thinking" };
      yield { type: "abort", reason: "user stopped" };
    }

    const events = await collectEvents(parts());

    const finished = eventsOfType<RunFinishedEvent>(events, EventType.RUN_FINISHED);
    expect(finished).toHaveLength(1);
    expect(finished[0].outcome).toEqual({ type: "cancelled" });
    expect(events[events.length - 1].type).toBe(EventType.RUN_FINISHED);
    expect(eventsOfType<RunErrorEvent>(events, EventType.RUN_ERROR)).toHaveLength(0);

    const idx = (type: EventType) => events.findIndex((e) => e.type === type);
    const finishedIdx = idx(EventType.RUN_FINISHED);
    for (const type of [
      EventType.TEXT_MESSAGE_END,
      EventType.TOOL_CALL_END,
      EventType.REASONING_MESSAGE_END,
      EventType.REASONING_END,
      EventType.STEP_FINISHED,
    ]) {
      expect(idx(type)).toBeGreaterThan(-1);
      expect(idx(type)).toBeLessThan(finishedIdx);
    }
    // Both tool calls are closed — the streamed-open one included.
    const toolEnds = eventsOfType(events, EventType.TOOL_CALL_END).map(
      (e) => (e as unknown as { toolCallId: string }).toolCallId,
    );
    expect(new Set(toolEnds)).toEqual(new Set(["tc-done", "tc-open"]));

    // A cancelled run must not fabricate results for calls it never ran.
    expect(eventsOfType<ToolCallResultEvent>(events, EventType.TOOL_CALL_RESULT)).toHaveLength(0);

    const snap = events[idx(EventType.MESSAGES_SNAPSHOT)] as MessagesSnapshotEvent;
    expect(snap.messages.some((m) => m.role === "tool")).toBe(false);
    const assistant = snap.messages.find((m) => m.role === "assistant") as AssistantMessage;
    expect(assistant.content).toBe("Partial");
    expect(assistant.toolCalls?.map((tc) => tc.id)).toEqual(["tc-done"]);
    expect(snap.messages.some((m) => m.role === "reasoning")).toBe(true);

    await expect(
      firstValueFrom(from(events).pipe(verifyEvents(), toArray())),
    ).resolves.toHaveLength(events.length);
  });

  it("emits RUN_ERROR + completes (no MESSAGES_SNAPSHOT, no RUN_FINISHED) when the for-await throws", async () => {
    async function* badStream(): AsyncIterable<FullStreamPart> {
      yield { type: "start" };
      throw new Error("synchronous fatal");
    }
    const events = await collectEvents(badStream());
    const errors = eventsOfType<RunErrorEvent>(events, EventType.RUN_ERROR);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe("synchronous fatal");
    expect(events.find((e) => e.type === EventType.MESSAGES_SNAPSHOT)).toBeUndefined();
    expect(events.find((e) => e.type === EventType.RUN_FINISHED)).toBeUndefined();
  });

  it("stops emitting events after the subscriber unsubscribes mid-stream", async () => {
    const collected: BaseEvent[] = [];
    let yieldedCount = 0;
    async function* parts(): AsyncIterable<FullStreamPart> {
      yield { type: "start" };
      yieldedCount++;
      yield { type: "text-start", id: "t" };
      yieldedCount++;
      yield { type: "text-delta", id: "t", text: "a" };
      yieldedCount++;
      yield { type: "text-delta", id: "t", text: "b" };
      yieldedCount++;
      yield { type: "text-end", id: "t" };
      yieldedCount++;
      yield fsFinish();
    }

    const observable = new Observable<BaseEvent>((subscriber: Subscriber<BaseEvent>) => {
      const handler = new StreamHandler(makeInput(), subscriber);
      handler.process(parts());
    });

    await new Promise<void>((resolve) => {
      const sub = observable.subscribe({
        next: (event) => {
          collected.push(event);
          if (collected.length === 2) {
            sub.unsubscribe();
            resolve();
          }
        },
      });
    });
    // After unsubscribe, no further events are pushed onto our array even if
    // the underlying iterator continues. Give the loop a tick to drain.
    await new Promise((r) => setTimeout(r, 50));
    expect(collected.length).toBe(2);
    expect(yieldedCount).toBeGreaterThanOrEqual(0); // sanity
  });
});

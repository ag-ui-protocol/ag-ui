/**
 * Tests for SSE parsing: text content, tool calls, edge cases, and buffer handling.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { WatsonxAgent } from "../index";
import { EventType, type BaseEvent } from "@ag-ui/core";
import { firstValueFrom, toArray } from "rxjs";
import type { RunAgentInput, Message } from "@ag-ui/core";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAgent() {
  return new WatsonxAgent({
    region: "us-south",
    instanceId: "inst-1",
    agentId: "agent-1",
    bearerToken: "tok",
  });
}

function makeInput(overrides: Partial<RunAgentInput> = {}): RunAgentInput {
  return {
    threadId: "t-1",
    runId: "r-1",
    messages: [{ id: "m-1", role: "user", content: "Hello" } as Message],
    state: null,
    tools: [],
    context: [],
    forwardedProps: {},
    ...overrides,
  };
}

function textChunk(content: string, finishReason?: string | null) {
  return {
    choices: [
      {
        delta: { content },
        finish_reason: finishReason ?? null,
      },
    ],
  };
}

function toolCallStartChunk(index: number, toolId: string, name: string) {
  return {
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index,
              id: toolId,
              function: { name },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  };
}

function toolCallArgsChunk(index: number, argsFragment: string) {
  return {
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index,
              function: { arguments: argsFragment },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  };
}

function toolCallFinishChunk() {
  return {
    choices: [
      {
        delta: {},
        finish_reason: "tool_calls",
      },
    ],
  };
}

function sseResponse(chunks: (object | string)[]): Response {
  const lines = chunks.map((c) =>
    typeof c === "string" ? c : `data: ${JSON.stringify(c)}`,
  );
  lines.push("data: [DONE]");
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(lines.join("\n") + "\n"));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/** Collect all events from a WatsonxAgent run. */
async function collectEvents(
  agent: WatsonxAgent,
  input?: RunAgentInput,
): Promise<BaseEvent[]> {
  const observable = agent.run(input ?? makeInput());
  return firstValueFrom(observable.pipe(toArray()));
}

/**
 * Mock fetch to return the SSE response for the watsonx chat endpoint
 * and a successful IAM response for any IAM calls.
 */
function mockFetch(sseResp: Response) {
  globalThis.fetch = vi.fn().mockImplementation((url: string) => {
    if (typeof url === "string" && url.includes("iam.cloud.ibm.com")) {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          access_token: "tok",
          expiration: Math.floor(Date.now() / 1000) + 3600,
        }),
      });
    }
    return Promise.resolve(sseResp);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SSE parsing", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("text content deltas", () => {
    it("emits TEXT_MESSAGE_START, CONTENT, and END for text chunks", async () => {
      const resp = sseResponse([
        textChunk("Hello"),
        textChunk(" world"),
        textChunk("!", "stop"),
      ]);
      mockFetch(resp);

      const events = await collectEvents(makeAgent());
      const types = events.map((e) => e.type);

      expect(types).toContain(EventType.TEXT_MESSAGE_START);
      expect(types).toContain(EventType.TEXT_MESSAGE_CONTENT);
      expect(types).toContain(EventType.TEXT_MESSAGE_END);

      const contentEvents = events.filter(
        (e) => e.type === EventType.TEXT_MESSAGE_CONTENT,
      );
      const fullText = contentEvents.map((e) => (e as any).delta).join("");
      expect(fullText).toBe("Hello world!");
    });

    it("TEXT_MESSAGE_START has role assistant", async () => {
      mockFetch(sseResponse([textChunk("Hi")]));
      const events = await collectEvents(makeAgent());
      const start = events.find(
        (e) => e.type === EventType.TEXT_MESSAGE_START,
      );
      expect((start as any).role).toBe("assistant");
    });
  });

  describe("tool call deltas", () => {
    it("emits TOOL_CALL_START, ARGS, and END for tool call chunks", async () => {
      mockFetch(
        sseResponse([
          toolCallStartChunk(0, "tc-1", "get_weather"),
          toolCallArgsChunk(0, '{"city":'),
          toolCallArgsChunk(0, '"NYC"}'),
          toolCallFinishChunk(),
        ]),
      );

      const events = await collectEvents(makeAgent());
      const types = events.map((e) => e.type);

      expect(types).toContain(EventType.TOOL_CALL_START);
      expect(types).toContain(EventType.TOOL_CALL_ARGS);
      expect(types).toContain(EventType.TOOL_CALL_END);

      const start = events.find((e) => e.type === EventType.TOOL_CALL_START);
      expect((start as any).toolCallId).toBe("tc-1");
      expect((start as any).toolCallName).toBe("get_weather");

      const argsEvents = events.filter(
        (e) => e.type === EventType.TOOL_CALL_ARGS,
      );
      const fullArgs = argsEvents.map((e) => (e as any).delta).join("");
      expect(JSON.parse(fullArgs)).toEqual({ city: "NYC" });
    });

    it("handles parallel tool calls with different indices", async () => {
      mockFetch(
        sseResponse([
          toolCallStartChunk(0, "tc-1", "get_weather"),
          toolCallStartChunk(1, "tc-2", "get_time"),
          toolCallArgsChunk(0, '{"city":"NYC"}'),
          toolCallArgsChunk(1, '{"tz":"EST"}'),
          toolCallFinishChunk(),
        ]),
      );

      const events = await collectEvents(makeAgent());

      const starts = events.filter(
        (e) => e.type === EventType.TOOL_CALL_START,
      );
      const ends = events.filter((e) => e.type === EventType.TOOL_CALL_END);
      expect(starts).toHaveLength(2);
      expect(ends).toHaveLength(2);

      const names = starts.map((e) => (e as any).toolCallName);
      expect(names).toContain("get_weather");
      expect(names).toContain("get_time");
    });
  });

  describe("edge cases", () => {
    it("silently skips malformed JSON lines", async () => {
      const body = [
        "data: not-json",
        `data: ${JSON.stringify(textChunk("works"))}`,
      ].join("\n") + "\ndata: [DONE]\n";

      const resp = new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(body));
            controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
      mockFetch(resp);

      const events = await collectEvents(makeAgent());
      const content = events.filter(
        (e) => e.type === EventType.TEXT_MESSAGE_CONTENT,
      );
      expect(content).toHaveLength(1);
      expect((content[0] as any).delta).toBe("works");
    });

    it("ignores non-data SSE lines (comments, event:, blank)", async () => {
      const body = [
        ": this is a comment",
        "",
        "event: ping",
        `data: ${JSON.stringify(textChunk("ok"))}`,
        "data: [DONE]",
      ].join("\n") + "\n";

      const resp = new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(body));
            controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
      mockFetch(resp);

      const events = await collectEvents(makeAgent());
      const content = events.filter(
        (e) => e.type === EventType.TEXT_MESSAGE_CONTENT,
      );
      expect(content).toHaveLength(1);
    });

    it("handles 'data:' without trailing space", async () => {
      const body = `data:${JSON.stringify(textChunk("no-space"))}\ndata: [DONE]\n`;

      const resp = new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(body));
            controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
      mockFetch(resp);

      const events = await collectEvents(makeAgent());
      const content = events.filter(
        (e) => e.type === EventType.TEXT_MESSAGE_CONTENT,
      );
      expect(content).toHaveLength(1);
      expect((content[0] as any).delta).toBe("no-space");
    });

    it("throws when buffer exceeds 1MB", async () => {
      // Create a response that sends >1MB without newlines so the buffer
      // accumulates without draining
      const bigPayload = "x".repeat(1024 * 1024 + 100);
      const resp = new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(bigPayload));
            controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
      mockFetch(resp);

      const events = await collectEvents(makeAgent());
      const errorEvent = events.find((e) => e.type === EventType.RUN_ERROR);
      expect(errorEvent).toBeDefined();
      expect((errorEvent as any).message).toContain("buffer exceeded 1MB");
    });

    it("processes trailing buffer after stream ends", async () => {
      // Send a chunk that doesn't end with a newline — it stays in the
      // buffer and should be processed when the stream closes.
      const chunk = textChunk("trailing");
      const body = `data: ${JSON.stringify(chunk)}`;
      // Note: no trailing newline, no [DONE]

      const resp = new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(body));
            controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
      mockFetch(resp);

      const events = await collectEvents(makeAgent());
      const content = events.filter(
        (e) => e.type === EventType.TEXT_MESSAGE_CONTENT,
      );
      expect(content).toHaveLength(1);
      expect((content[0] as any).delta).toBe("trailing");
    });

    it("empty stream (only [DONE]) produces no text events", async () => {
      mockFetch(sseResponse([]));
      const events = await collectEvents(makeAgent());
      const types = events.map((e) => e.type);

      expect(types).not.toContain(EventType.TEXT_MESSAGE_START);
      expect(types).not.toContain(EventType.TEXT_MESSAGE_CONTENT);
      expect(types).not.toContain(EventType.TEXT_MESSAGE_END);
      // But lifecycle events are still there
      expect(types).toContain(EventType.RUN_STARTED);
      expect(types).toContain(EventType.RUN_FINISHED);
    });
  });

  describe("finish_reason handling", () => {
    it("finish_reason 'stop' closes the text message", async () => {
      mockFetch(
        sseResponse([
          textChunk("Hello"),
          textChunk("", "stop"),
        ]),
      );

      const events = await collectEvents(makeAgent());
      const types = events.map((e) => e.type);

      // TEXT_MESSAGE_END should appear once from the finish_reason
      const endEvents = events.filter(
        (e) => e.type === EventType.TEXT_MESSAGE_END,
      );
      expect(endEvents.length).toBeGreaterThanOrEqual(1);
    });

    it("finish_reason 'tool_calls' closes tool calls and clears map", async () => {
      mockFetch(
        sseResponse([
          toolCallStartChunk(0, "tc-1", "search"),
          toolCallArgsChunk(0, '{"q":"test"}'),
          toolCallFinishChunk(),
        ]),
      );

      const events = await collectEvents(makeAgent());
      const ends = events.filter((e) => e.type === EventType.TOOL_CALL_END);
      expect(ends).toHaveLength(1);
      expect((ends[0] as any).toolCallId).toBe("tc-1");
    });
  });
});

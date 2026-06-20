/**
 * Tests for the full event lifecycle:
 * RUN_STARTED → STEP_STARTED → content → STEP_FINISHED → MESSAGES_SNAPSHOT → RUN_FINISHED
 * Plus error paths, RAW events, and TOOL_CALL_RESULT.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { WatsonxAgent } from "../index";
import { EventType, type BaseEvent, type RunAgentInput, type Message } from "@ag-ui/core";
import { firstValueFrom, toArray } from "rxjs";

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

async function collectEvents(
  agent: WatsonxAgent,
  input?: RunAgentInput,
): Promise<BaseEvent[]> {
  const observable = agent.run(input ?? makeInput());
  return firstValueFrom(observable.pipe(toArray()));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Event lifecycle", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("follows full happy-path lifecycle order", async () => {
    mockFetch(sseResponse([textChunk("Hi")]));

    const events = await collectEvents(makeAgent());
    const types = events.map((e) => e.type);

    // RUN_STARTED must be first
    expect(types[0]).toBe(EventType.RUN_STARTED);
    // RUN_FINISHED must be last
    expect(types[types.length - 1]).toBe(EventType.RUN_FINISHED);

    // Verify ordering: STEP_STARTED before STEP_FINISHED
    const stepStartIdx = types.indexOf(EventType.STEP_STARTED);
    const stepFinishIdx = types.indexOf(EventType.STEP_FINISHED);
    expect(stepStartIdx).toBeGreaterThan(0);
    expect(stepFinishIdx).toBeGreaterThan(stepStartIdx);

    // MESSAGES_SNAPSHOT comes after STEP_FINISHED and before RUN_FINISHED
    const snapshotIdx = types.indexOf(EventType.MESSAGES_SNAPSHOT);
    expect(snapshotIdx).toBeGreaterThan(stepFinishIdx);
    expect(snapshotIdx).toBeLessThan(types.length - 1);
  });

  it("emits RUN_STARTED with threadId and runId", async () => {
    mockFetch(sseResponse([textChunk("Hi")]));
    const input = makeInput({ threadId: "my-thread", runId: "my-run" });
    const events = await collectEvents(makeAgent(), input);

    const runStarted = events.find((e) => e.type === EventType.RUN_STARTED);
    expect((runStarted as any).threadId).toBe("my-thread");
    expect((runStarted as any).runId).toBe("my-run");
  });

  it("emits RUN_FINISHED with threadId and runId", async () => {
    mockFetch(sseResponse([textChunk("Hi")]));
    const input = makeInput({ threadId: "my-thread", runId: "my-run" });
    const events = await collectEvents(makeAgent(), input);

    const runFinished = events.find((e) => e.type === EventType.RUN_FINISHED);
    expect((runFinished as any).threadId).toBe("my-thread");
    expect((runFinished as any).runId).toBe("my-run");
  });

  it("STEP_STARTED and STEP_FINISHED have stepName 'watsonx-orchestrate'", async () => {
    mockFetch(sseResponse([textChunk("Hi")]));
    const events = await collectEvents(makeAgent());

    const stepStart = events.find((e) => e.type === EventType.STEP_STARTED);
    const stepFinish = events.find((e) => e.type === EventType.STEP_FINISHED);
    expect((stepStart as any).stepName).toBe("watsonx-orchestrate");
    expect((stepFinish as any).stepName).toBe("watsonx-orchestrate");
  });

  describe("error path", () => {
    it("emits RUN_STARTED then RUN_ERROR on HTTP failure", async () => {
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
        return Promise.resolve(
          new Response(null, { status: 500 }),
        );
      });

      const events = await collectEvents(makeAgent());
      const types = events.map((e) => e.type);

      expect(types[0]).toBe(EventType.RUN_STARTED);
      expect(types).toContain(EventType.RUN_ERROR);

      const error = events.find((e) => e.type === EventType.RUN_ERROR);
      expect((error as any).code).toBe("WATSONX_ERROR");
      expect((error as any).message).toContain("HTTP 500");
    });

    it("emits STEP_FINISHED before RUN_ERROR when step was in progress", async () => {
      // Simulate an error after STEP_STARTED by having fetch succeed initially
      // but the stream throws
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
        // Return a response whose body stream errors
        const body = new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify(textChunk("partial"))}\n`,
              ),
            );
            // Simulate stream error
            controller.error(new Error("stream broken"));
          },
        });
        return Promise.resolve(
          new Response(body, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
        );
      });

      const events = await collectEvents(makeAgent());
      const types = events.map((e) => e.type);

      // Error path should still complete — STEP_FINISHED emitted before RUN_ERROR
      expect(types).toContain(EventType.RUN_ERROR);
      const errorIdx = types.indexOf(EventType.RUN_ERROR);
      // STEP_FINISHED should appear before RUN_ERROR
      const stepFinishIdx = types.indexOf(EventType.STEP_FINISHED);
      expect(stepFinishIdx).toBeLessThan(errorIdx);
    });
  });

  describe("MESSAGES_SNAPSHOT", () => {
    it("contains input messages plus assistant response", async () => {
      mockFetch(sseResponse([textChunk("Hello back")]));
      const input = makeInput({
        messages: [{ id: "m-1", role: "user", content: "Hello" } as Message],
      });
      const events = await collectEvents(makeAgent(), input);

      const snapshot = events.find(
        (e) => e.type === EventType.MESSAGES_SNAPSHOT,
      );
      expect(snapshot).toBeDefined();
      const msgs = (snapshot as any).messages;
      expect(msgs).toHaveLength(2);
      expect(msgs[0].role).toBe("user");
      expect(msgs[0].content).toBe("Hello");
      expect(msgs[1].role).toBe("assistant");
      expect(msgs[1].content).toBe("Hello back");
    });

    it("contains only input messages when stream has no text content", async () => {
      mockFetch(sseResponse([]));
      const input = makeInput({
        messages: [{ id: "m-1", role: "user", content: "Hello" } as Message],
      });
      const events = await collectEvents(makeAgent(), input);

      const snapshot = events.find(
        (e) => e.type === EventType.MESSAGES_SNAPSHOT,
      );
      const msgs = (snapshot as any).messages;
      expect(msgs).toHaveLength(1);
      expect(msgs[0].role).toBe("user");
    });
  });

  describe("RAW events", () => {
    it("emits a RAW event for each parsed SSE chunk", async () => {
      mockFetch(
        sseResponse([textChunk("a"), textChunk("b")]),
      );
      const events = await collectEvents(makeAgent());

      const rawEvents = events.filter((e) => e.type === EventType.RAW);
      expect(rawEvents).toHaveLength(2);
      expect((rawEvents[0] as any).source).toBe("watsonx");
      // Verify the event payload contains the original chunk data
      expect((rawEvents[0] as any).event.choices).toBeDefined();
    });
  });

  describe("TOOL_CALL_RESULT for tool messages in input", () => {
    it("emits TOOL_CALL_RESULT for each tool message in input", async () => {
      mockFetch(sseResponse([textChunk("Noted")]));

      const input = makeInput({
        messages: [
          { id: "m-1", role: "user", content: "Hello" } as Message,
          {
            id: "m-2",
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: "tc-1",
                type: "function" as const,
                function: { name: "search", arguments: '{"q":"test"}' },
              },
            ],
          } as Message,
          {
            id: "m-3",
            role: "tool",
            toolCallId: "tc-1",
            content: "42",
          } as Message,
        ],
      });

      const events = await collectEvents(makeAgent(), input);

      const toolResults = events.filter(
        (e) => e.type === EventType.TOOL_CALL_RESULT,
      );
      expect(toolResults).toHaveLength(1);
      expect((toolResults[0] as any).toolCallId).toBe("tc-1");
      expect((toolResults[0] as any).content).toBe("42");
      expect((toolResults[0] as any).role).toBe("tool");
    });

    it("emits TOOL_CALL_RESULT before STEP_STARTED", async () => {
      mockFetch(sseResponse([textChunk("ok")]));

      const input = makeInput({
        messages: [
          { id: "m-1", role: "user", content: "Hello" } as Message,
          {
            id: "m-2",
            role: "tool",
            toolCallId: "tc-1",
            content: "result",
          } as Message,
        ],
      });

      const events = await collectEvents(makeAgent(), input);
      const types = events.map((e) => e.type);

      const toolResultIdx = types.indexOf(EventType.TOOL_CALL_RESULT);
      const stepStartIdx = types.indexOf(EventType.STEP_STARTED);
      expect(toolResultIdx).toBeLessThan(stepStartIdx);
    });
  });
});

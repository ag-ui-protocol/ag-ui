import { describe, it, expect, vi, beforeEach } from "vitest";
import { VercelAISDKAgent } from "../index";
import { RunAgentInput } from "@ag-ui/client";
import { firstValueFrom, toArray } from "rxjs";
import type { LanguageModelV1 } from "ai";

// Mock the `ai` module so we can intercept streamText calls
const mockStreamText = vi.fn();

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    streamText: (...args: unknown[]) => {
      mockStreamText(...args);
      // Return a minimal streamText-like response that processDataStream can consume
      const stream = new ReadableStream({
        start(controller) {
          // Vercel AI SDK data stream protocol:
          // '0:"text"\n' = text part
          // 'e:{"finishReason":"stop","usage":{"promptTokens":1,"completionTokens":1},"isContinued":false}\n' = finish step
          // 'd:{"finishReason":"stop","usage":{"promptTokens":1,"completionTokens":1}}\n' = finish message
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode('0:"hello"\n'));
          controller.enqueue(
            encoder.encode(
              'e:{"finishReason":"stop","usage":{"promptTokens":1,"completionTokens":1},"isContinued":false}\n',
            ),
          );
          controller.enqueue(
            encoder.encode(
              'd:{"finishReason":"stop","usage":{"promptTokens":1,"completionTokens":1}}\n',
            ),
          );
          controller.close();
        },
      });

      return {
        toDataStreamResponse: () => ({
          body: stream,
        }),
      };
    },
  };
});

// streamText is mocked above, so the model is never called.
const mockModel: LanguageModelV1 = {
  specificationVersion: "v1",
  provider: "test",
  modelId: "test-model",
  defaultObjectGenerationMode: "json",
  supportsImageUrls: false,
  supportsStructuredOutputs: false,
  doGenerate: vi.fn<LanguageModelV1["doGenerate"]>(),
  doStream: vi.fn<LanguageModelV1["doStream"]>(),
};

function createAgent() {
  return new VercelAISDKAgent({ agentId: "test", model: mockModel });
}

function makeInput(overrides?: Partial<RunAgentInput>): RunAgentInput {
  return {
    threadId: "thread-1",
    runId: "run-1",
    messages: [{ id: "msg-1", role: "user", content: "Hello" }],
    tools: [],
    context: [],
    forwardedProps: {},
    ...overrides,
  };
}

describe("VercelAISDKAgent header forwarding", () => {
  beforeEach(() => {
    mockStreamText.mockClear();
  });

  it("forwards headers to streamText when set", async () => {
    const agent = createAgent();
    agent.headers = {
      "x-aimock-context": "vercel-test",
      "x-test-id": "abc-123",
    };

    const events = await firstValueFrom(agent.run(makeInput()).pipe(toArray()));

    expect(events.length).toBeGreaterThan(0);
    expect(mockStreamText).toHaveBeenCalledTimes(1);

    const callArgs = mockStreamText.mock.calls[0][0];
    expect(callArgs.headers).toEqual({
      "x-aimock-context": "vercel-test",
      "x-test-id": "abc-123",
    });
  });

  it("does not include headers in streamText call when headers is undefined", async () => {
    const agent = createAgent();
    // headers is undefined by default

    const events = await firstValueFrom(agent.run(makeInput()).pipe(toArray()));

    expect(events.length).toBeGreaterThan(0);
    expect(mockStreamText).toHaveBeenCalledTimes(1);

    const callArgs = mockStreamText.mock.calls[0][0];
    expect(callArgs).not.toHaveProperty("headers");
  });

  describe("clone()", () => {
    it("preserves headers across clone()", () => {
      const agent = createAgent();
      agent.headers = {
        "x-aimock-context": "test-clone",
        "x-test-id": "clone-123",
      };

      const cloned = agent.clone();

      expect(cloned.headers).toEqual({
        "x-aimock-context": "test-clone",
        "x-test-id": "clone-123",
      });
    });

    it("creates a defensive copy (mutating clone does not affect original)", () => {
      const agent = createAgent();
      agent.headers = { "x-aimock-context": "original" };

      const cloned = agent.clone();
      cloned.headers!["x-aimock-context"] = "mutated";
      cloned.headers!["x-new"] = "added";

      expect(agent.headers).toEqual({ "x-aimock-context": "original" });
      expect(cloned.headers).not.toBe(agent.headers);
    });

    it("leaves headers undefined on clone when not set on original", () => {
      const agent = createAgent();

      const cloned = agent.clone();

      expect(cloned.headers).toBeUndefined();
    });
  });

  it("does not include headers in streamText call when headers is empty", async () => {
    const agent = createAgent();
    agent.headers = {};

    const events = await firstValueFrom(agent.run(makeInput()).pipe(toArray()));

    expect(events.length).toBeGreaterThan(0);
    expect(mockStreamText).toHaveBeenCalledTimes(1);

    const callArgs = mockStreamText.mock.calls[0][0];
    expect(callArgs).not.toHaveProperty("headers");
  });
});

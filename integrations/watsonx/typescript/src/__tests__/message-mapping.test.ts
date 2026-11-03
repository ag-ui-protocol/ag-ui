/**
 * Tests for message mapping: AG-UI messages to watsonx format,
 * tool forwarding, and forwardedProps filtering.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { WatsonxAgent } from "../index";
import { EventType, type BaseEvent, type RunAgentInput, type Message, type Tool } from "@ag-ui/core";
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

/** Capture the request body sent to the watsonx chat endpoint. */
function captureFetch(): { getBody: () => Record<string, unknown> } {
  let capturedBody: Record<string, unknown> | null = null;

  globalThis.fetch = vi.fn().mockImplementation((url: string, opts?: any) => {
    if (typeof url === "string" && url.includes("iam.cloud.ibm.com")) {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          access_token: "tok",
          expiration: Math.floor(Date.now() / 1000) + 3600,
        }),
      });
    }
    if (opts?.body) {
      capturedBody = JSON.parse(opts.body);
    }
    return Promise.resolve(sseResponse([textChunk("ok")]));
  });

  return {
    getBody: () => {
      if (!capturedBody) throw new Error("No request body captured");
      return capturedBody;
    },
  };
}

async function collectEvents(
  agent: WatsonxAgent,
  input: RunAgentInput,
): Promise<BaseEvent[]> {
  const observable = agent.run(input);
  return firstValueFrom(observable.pipe(toArray()));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Message mapping", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("maps user messages correctly", async () => {
    const capture = captureFetch();
    const input: RunAgentInput = {
      threadId: "t-1",
      runId: "r-1",
      messages: [{ id: "m-1", role: "user", content: "Hello" } as Message],
      state: null,
      tools: [],
      context: [],
      forwardedProps: {},
    };

    await collectEvents(makeAgent(), input);

    const body = capture.getBody();
    const msgs = body.messages as any[];
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("user");
    expect(msgs[0].content).toBe("Hello");
  });

  it("maps assistant messages with toolCalls", async () => {
    const capture = captureFetch();
    const input: RunAgentInput = {
      threadId: "t-1",
      runId: "r-1",
      messages: [
        {
          id: "a-1",
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
      ],
      state: null,
      tools: [],
      context: [],
      forwardedProps: {},
    };

    await collectEvents(makeAgent(), input);

    const body = capture.getBody();
    const msgs = body.messages as any[];
    expect(msgs[0].role).toBe("assistant");
    expect(msgs[0].tool_calls).toHaveLength(1);
    expect(msgs[0].tool_calls[0].id).toBe("tc-1");
    expect(msgs[0].tool_calls[0].type).toBe("function");
    expect(msgs[0].tool_calls[0].function.name).toBe("search");
    expect(msgs[0].tool_calls[0].function.arguments).toBe('{"q":"test"}');
  });

  it("maps tool messages with tool_call_id", async () => {
    const capture = captureFetch();
    const input: RunAgentInput = {
      threadId: "t-1",
      runId: "r-1",
      messages: [
        {
          id: "t-1",
          role: "tool",
          toolCallId: "tc-1",
          content: "42",
        } as Message,
      ],
      state: null,
      tools: [],
      context: [],
      forwardedProps: {},
    };

    await collectEvents(makeAgent(), input);

    const body = capture.getBody();
    const msgs = body.messages as any[];
    expect(msgs[0].role).toBe("tool");
    expect(msgs[0].tool_call_id).toBe("tc-1");
    expect(msgs[0].content).toBe("42");
  });

  describe("content parts", () => {
    const IMAGE_B64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

    function partsInput(messages: Message[]): RunAgentInput {
      return {
        threadId: "t-1",
        runId: "r-1",
        messages,
        state: null,
        tools: [],
        context: [],
        forwardedProps: {},
      };
    }

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("builds the prompt from text parts only", async () => {
      const capture = captureFetch();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      await collectEvents(
        makeAgent(),
        partsInput([
          {
            id: "m-1",
            role: "user",
            content: [
              { type: "text", text: "hello " },
              { type: "text", text: "world" },
            ],
          },
        ]),
      );

      const msgs = capture.getBody().messages as any[];
      expect(msgs[0].content).toBe("hello world");
      expect(warn).not.toHaveBeenCalled();
    });

    it("drops media parts with a warning instead of dumping them into the prompt", async () => {
      const capture = captureFetch();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      await collectEvents(
        makeAgent(),
        partsInput([
          {
            id: "m-1",
            role: "user",
            content: [
              { type: "text", text: "Describe this" },
              {
                type: "image",
                source: { type: "data", value: IMAGE_B64, mimeType: "image/png" },
              },
              {
                type: "document",
                source: { type: "url", value: "https://example.com/file.pdf" },
              },
            ],
          },
        ]),
      );

      const body = capture.getBody();
      const msgs = body.messages as any[];
      expect(msgs[0].content).toBe("Describe this");
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain(IMAGE_B64);
      expect(serialized).not.toContain("https://example.com/file.pdf");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toMatch(/image, document/);
    });

    it("flattens array tool content for the prompt but re-emits it unchanged in TOOL_CALL_RESULT", async () => {
      const capture = captureFetch();
      const parts = [
        { type: "text" as const, text: "Sunny, " },
        { type: "text" as const, text: "72F" },
      ];

      const events = await collectEvents(
        makeAgent(),
        partsInput([
          { id: "u-1", role: "user", content: "Weather?" },
          { id: "tm-1", role: "tool", toolCallId: "tc-1", content: parts },
        ]),
      );

      const msgs = capture.getBody().messages as any[];
      expect(msgs[1]).toEqual({
        role: "tool",
        content: "Sunny, 72F",
        tool_call_id: "tc-1",
      });
      const result = events.find((e) => e.type === EventType.TOOL_CALL_RESULT);
      expect((result as any).content).toEqual(parts);
    });
  });

  it("filters reserved keys from forwardedProps", async () => {
    const capture = captureFetch();
    const input: RunAgentInput = {
      threadId: "t-1",
      runId: "r-1",
      messages: [{ id: "m-1", role: "user", content: "Hello" } as Message],
      state: null,
      tools: [],
      context: [],
      forwardedProps: {
        messages: [{ role: "system", content: "hacked" }],
        stream: false,
        tools: [{ name: "hacked" }],
        temperature: 0.7,
        model: "gpt-4",
      },
    };

    await collectEvents(makeAgent(), input);

    const body = capture.getBody();
    // Reserved keys should not override the built request
    expect(body.stream).toBe(true); // Must always be true
    // The actual messages should be from the input, not forwardedProps
    expect((body.messages as any[])[0].content).toBe("Hello");
    // Non-reserved keys should pass through
    expect(body.temperature).toBe(0.7);
    expect(body.model).toBe("gpt-4");
  });

  it("forwards tools in OpenAI function format", async () => {
    const capture = captureFetch();
    const tools: Tool[] = [
      {
        name: "get_weather",
        description: "Get weather for a city",
        parameters: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
    ];

    const input: RunAgentInput = {
      threadId: "t-1",
      runId: "r-1",
      messages: [{ id: "m-1", role: "user", content: "Hello" } as Message],
      state: null,
      tools,
      context: [],
      forwardedProps: {},
    };

    await collectEvents(makeAgent(), input);

    const body = capture.getBody();
    const bodyTools = body.tools as any[];
    expect(bodyTools).toHaveLength(1);
    expect(bodyTools[0].type).toBe("function");
    expect(bodyTools[0].function.name).toBe("get_weather");
    expect(bodyTools[0].function.description).toBe("Get weather for a city");
    expect(bodyTools[0].function.parameters).toEqual({
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    });
  });

  it("does not include tools in request body when tools array is empty", async () => {
    const capture = captureFetch();
    const input: RunAgentInput = {
      threadId: "t-1",
      runId: "r-1",
      messages: [{ id: "m-1", role: "user", content: "Hello" } as Message],
      state: null,
      tools: [],
      context: [],
      forwardedProps: {},
    };

    await collectEvents(makeAgent(), input);

    const body = capture.getBody();
    expect(body.tools).toBeUndefined();
  });

  it("sends correct headers including X-IBM-THREAD-ID and Authorization", async () => {
    let capturedHeaders: Record<string, string> | null = null;

    globalThis.fetch = vi.fn().mockImplementation((url: string, opts?: any) => {
      if (typeof url === "string" && url.includes("iam.cloud.ibm.com")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            access_token: "tok",
            expiration: Math.floor(Date.now() / 1000) + 3600,
          }),
        });
      }
      capturedHeaders = opts?.headers ?? null;
      return Promise.resolve(sseResponse([textChunk("ok")]));
    });

    const input: RunAgentInput = {
      threadId: "my-thread-42",
      runId: "r-1",
      messages: [{ id: "m-1", role: "user", content: "Hello" } as Message],
      state: null,
      tools: [],
      context: [],
      forwardedProps: {},
    };

    await collectEvents(makeAgent(), input);

    expect(capturedHeaders).toBeDefined();
    expect(capturedHeaders!["X-IBM-THREAD-ID"]).toBe("my-thread-42");
    expect(capturedHeaders!["Authorization"]).toBe("Bearer tok");
    expect(capturedHeaders!["Content-Type"]).toBe("application/json");
  });

  it("maps system messages correctly", async () => {
    const capture = captureFetch();
    const input: RunAgentInput = {
      threadId: "t-1",
      runId: "r-1",
      messages: [
        { id: "s-1", role: "system", content: "Be helpful" } as Message,
        { id: "m-1", role: "user", content: "Hello" } as Message,
      ],
      state: null,
      tools: [],
      context: [],
      forwardedProps: {},
    };

    await collectEvents(makeAgent(), input);

    const body = capture.getBody();
    const msgs = body.messages as any[];
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe("system");
    expect(msgs[0].content).toBe("Be helpful");
  });
});

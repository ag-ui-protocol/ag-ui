import { describe, it, expect, vi } from "vitest";
import { EventType, RunAgentInput } from "@ag-ui/client";
import { LangChainAgent, ChainFnParams } from "../agent";
import { firstValueFrom, toArray } from "rxjs";

/**
 * Creates a minimal mock model with a .stream() method that resolves to a
 * string (the simplest LangChainResponse type — see streaming.ts).
 *
 * The mock captures the call arguments so tests can assert on them.
 */
function createMockModel() {
  const streamMock = vi.fn().mockResolvedValue("test response");
  return {
    stream: streamMock,
    bindTools: vi.fn().mockReturnValue({ stream: streamMock }),
    _streamMock: streamMock,
  };
}

/**
 * Minimal RunAgentInput for testing.
 */
function makeInput(overrides?: Partial<RunAgentInput>): RunAgentInput {
  return {
    threadId: "thread-1",
    runId: "run-1",
    messages: [{ id: "msg-1", role: "user", content: "hello" }],
    tools: [],
    context: [],
    forwardedProps: {},
    ...overrides,
  } as RunAgentInput;
}

/**
 * Helper to collect all events from a LangChainAgent run.
 */
async function collectEvents(agent: LangChainAgent, input: RunAgentInput) {
  return firstValueFrom(agent.run(input).pipe(toArray()));
}

describe("LangChainAgent header forwarding", () => {
  describe("model pattern", () => {
    it("forwards headers via options.headers when headers are set", async () => {
      const mockModel = createMockModel();
      const agent = new LangChainAgent({
        model: mockModel as any,
      });

      agent.headers = {
        "x-aimock-context": "langchain-test",
        "x-test-id": "test-123",
      };

      await collectEvents(agent, makeInput());

      // The model.stream() call should have received options.headers
      const streamCall = mockModel._streamMock.mock.calls[0];
      expect(streamCall).toBeDefined();

      const callOptions = streamCall[1];
      expect(callOptions).toBeDefined();
      expect(callOptions.options).toBeDefined();
      expect(callOptions.options.headers).toEqual({
        "x-aimock-context": "langchain-test",
        "x-test-id": "test-123",
      });
    });

    it("does not include options key when headers are not set", async () => {
      const mockModel = createMockModel();
      const agent = new LangChainAgent({
        model: mockModel as any,
      });

      // No headers set — agent.headers is undefined

      await collectEvents(agent, makeInput());

      const streamCall = mockModel._streamMock.mock.calls[0];
      expect(streamCall).toBeDefined();

      const callOptions = streamCall[1];
      expect(callOptions).toBeDefined();
      expect(callOptions.signal).toBeInstanceOf(AbortSignal);
      // options key should NOT be present
      expect(callOptions.options).toBeUndefined();
    });

    it("does not include options key when headers are empty object", async () => {
      const mockModel = createMockModel();
      const agent = new LangChainAgent({
        model: mockModel as any,
      });

      agent.headers = {};

      await collectEvents(agent, makeInput());

      const streamCall = mockModel._streamMock.mock.calls[0];
      const callOptions = streamCall[1];
      expect(callOptions.options).toBeUndefined();
    });

    it("still emits RUN_STARTED and RUN_FINISHED with headers set", async () => {
      const mockModel = createMockModel();
      const agent = new LangChainAgent({
        model: mockModel as any,
      });

      agent.headers = { "x-aimock-context": "test" };

      const events = await collectEvents(agent, makeInput());
      const types = events.map((e) => e.type);

      expect(types[0]).toBe(EventType.RUN_STARTED);
      expect(types[types.length - 1]).toBe(EventType.RUN_FINISHED);
    });
  });

  describe("chainFn pattern", () => {
    it("exposes headers in chainFn params when headers are set", async () => {
      let receivedParams: ChainFnParams | undefined;

      const agent = new LangChainAgent({
        chainFn: async (params: ChainFnParams) => {
          receivedParams = params;
          return "test response";
        },
      });

      agent.headers = {
        "x-aimock-context": "langchain-chainfn-test",
        "x-custom-header": "value",
      };

      await collectEvents(agent, makeInput());

      expect(receivedParams).toBeDefined();
      expect(receivedParams!.headers).toEqual({
        "x-aimock-context": "langchain-chainfn-test",
        "x-custom-header": "value",
      });
    });

    it("passes undefined headers when no headers are set on agent", async () => {
      let receivedParams: ChainFnParams | undefined;

      const agent = new LangChainAgent({
        chainFn: async (params: ChainFnParams) => {
          receivedParams = params;
          return "test response";
        },
      });

      // No headers set

      await collectEvents(agent, makeInput());

      expect(receivedParams).toBeDefined();
      // headers field exists in params but its value is undefined
      expect("headers" in receivedParams!).toBe(true);
      expect(receivedParams!.headers).toBeUndefined();
    });

    it("chainFn can destructure headers alongside other params", async () => {
      let capturedHeaders: Record<string, string> | undefined;
      let capturedThreadId: string | undefined;

      const agent = new LangChainAgent({
        chainFn: async ({ headers, threadId }: ChainFnParams) => {
          capturedHeaders = headers;
          capturedThreadId = threadId;
          return "test response";
        },
      });

      agent.headers = { "x-test": "works" };

      await collectEvents(agent, makeInput({ threadId: "thread-42" }));

      expect(capturedHeaders).toEqual({ "x-test": "works" });
      expect(capturedThreadId).toBe("thread-42");
    });
  });

  describe("clone()", () => {
    it("preserves headers across clone()", () => {
      const agent = new LangChainAgent({
        chainFn: async () => "test",
      });
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
      const agent = new LangChainAgent({
        chainFn: async () => "test",
      });
      agent.headers = { "x-aimock-context": "original" };

      const cloned = agent.clone();
      cloned.headers!["x-aimock-context"] = "mutated";
      cloned.headers!["x-new"] = "added";

      expect(agent.headers).toEqual({ "x-aimock-context": "original" });
      expect(cloned.headers).not.toBe(agent.headers);
    });

    it("leaves headers undefined on clone when not set on original", () => {
      const agent = new LangChainAgent({
        chainFn: async () => "test",
      });

      const cloned = agent.clone();

      expect(cloned.headers).toBeUndefined();
    });
  });

  describe("headers property", () => {
    it("is publicly assignable on the agent instance", () => {
      const agent = new LangChainAgent({
        chainFn: async () => "test",
      });

      // Verify initial state
      expect(agent.headers).toBeUndefined();

      // Verify assignment works (as CopilotKit Runtime does)
      agent.headers = { "x-aimock-context": "test" };
      expect(agent.headers).toEqual({ "x-aimock-context": "test" });

      // Verify spread-merge pattern (as configureAgentForRequest does)
      agent.headers = {
        ...agent.headers,
        "x-new-header": "value",
      };
      expect(agent.headers).toEqual({
        "x-aimock-context": "test",
        "x-new-header": "value",
      });
    });
  });
});

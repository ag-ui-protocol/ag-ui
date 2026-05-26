import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock workspace packages that aren't built in worktree isolation
vi.mock("@ag-ui/client", () => {
  class AbstractAgent {
    constructor(_config?: Record<string, unknown>) {}
    clone() {
      return Object.assign(Object.create(Object.getPrototypeOf(this)), this);
    }
  }
  return {
    AbstractAgent,
    EventType: {
      RUN_STARTED: "RUN_STARTED",
      RUN_FINISHED: "RUN_FINISHED",
      RUN_ERROR: "RUN_ERROR",
      TEXT_MESSAGE_START: "TEXT_MESSAGE_START",
      TEXT_MESSAGE_CONTENT: "TEXT_MESSAGE_CONTENT",
      TEXT_MESSAGE_END: "TEXT_MESSAGE_END",
      TOOL_CALL_START: "TOOL_CALL_START",
      TOOL_CALL_ARGS: "TOOL_CALL_ARGS",
      TOOL_CALL_END: "TOOL_CALL_END",
      TOOL_CALL_RESULT: "TOOL_CALL_RESULT",
      STATE_SNAPSHOT: "STATE_SNAPSHOT",
      MESSAGES_SNAPSHOT: "MESSAGES_SNAPSHOT",
      CUSTOM: "CUSTOM",
      REASONING_START: "REASONING_START",
      REASONING_MESSAGE_START: "REASONING_MESSAGE_START",
      REASONING_MESSAGE_CONTENT: "REASONING_MESSAGE_CONTENT",
      REASONING_MESSAGE_END: "REASONING_MESSAGE_END",
      REASONING_END: "REASONING_END",
      REASONING_ENCRYPTED_VALUE: "REASONING_ENCRYPTED_VALUE",
    },
    randomUUID: () => crypto.randomUUID(),
  };
});

vi.mock("@ag-ui/core", () => ({}));

// Mock the Claude Agent SDK so we don't need real API credentials
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(() => {
    // Return an async iterable that immediately yields a result message
    return {
      [Symbol.asyncIterator]: () => ({
        next: vi
          .fn()
          .mockResolvedValueOnce({
            value: {
              type: "result",
              result: "test response",
              is_error: false,
            },
            done: false,
          })
          .mockResolvedValueOnce({ value: undefined, done: true }),
      }),
      interrupt: vi.fn(),
    };
  }),
  createSdkMcpServer: vi.fn(() => ({})),
}));

// Mock the SDK types import
vi.mock("@anthropic-ai/sdk/resources/beta/messages/messages", () => ({}));

import { ClaudeAgentAdapter } from "./adapter";

describe("ClaudeAgentAdapter headers property", () => {
  let debugSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    // Also suppress console.error from adapter error paths
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits debug log when headers are set", async () => {
    const adapter = new ClaudeAgentAdapter({ model: "claude-haiku-4-5" });
    adapter.headers = { "x-aimock-context": "test-integration" };

    const events: unknown[] = [];
    await new Promise<void>((resolve, reject) => {
      adapter
        .run({
          threadId: "t1",
          runId: "r1",
          messages: [],
          tools: [],
          context: [],
        })
        .subscribe({
          next: (event) => events.push(event),
          error: reject,
          complete: resolve,
        });
    });

    expect(debugSpy).toHaveBeenCalledWith(
      "[ClaudeAdapter] headers set but not forwarded (Claude Agent SDK does not support per-request HTTP headers)",
    );
  });

  it("does NOT emit debug log when headers are undefined", async () => {
    const adapter = new ClaudeAgentAdapter({ model: "claude-haiku-4-5" });
    // headers left undefined

    const events: unknown[] = [];
    await new Promise<void>((resolve, reject) => {
      adapter
        .run({
          threadId: "t2",
          runId: "r2",
          messages: [],
          tools: [],
          context: [],
        })
        .subscribe({
          next: (event) => events.push(event),
          error: reject,
          complete: resolve,
        });
    });

    const headerCalls = debugSpy.mock.calls.filter(
      (call: unknown[]) =>
        typeof call[0] === "string" &&
        call[0].includes("headers set but not forwarded"),
    );
    expect(headerCalls).toHaveLength(0);
  });

  it("does NOT emit debug log when headers is an empty object", async () => {
    const adapter = new ClaudeAgentAdapter({ model: "claude-haiku-4-5" });
    adapter.headers = {};

    const events: unknown[] = [];
    await new Promise<void>((resolve, reject) => {
      adapter
        .run({
          threadId: "t3",
          runId: "r3",
          messages: [],
          tools: [],
          context: [],
        })
        .subscribe({
          next: (event) => events.push(event),
          error: reject,
          complete: resolve,
        });
    });

    const headerCalls = debugSpy.mock.calls.filter(
      (call: unknown[]) =>
        typeof call[0] === "string" &&
        call[0].includes("headers set but not forwarded"),
    );
    expect(headerCalls).toHaveLength(0);
  });

  describe("clone()", () => {
    it("preserves headers across clone()", () => {
      const adapter = new ClaudeAgentAdapter({ model: "claude-haiku-4-5" });
      adapter.headers = {
        "x-aimock-context": "test-clone",
        "x-test-id": "clone-123",
      };

      const cloned = adapter.clone();

      expect(cloned.headers).toEqual({
        "x-aimock-context": "test-clone",
        "x-test-id": "clone-123",
      });
    });

    it("creates a defensive copy (mutating clone does not affect original)", () => {
      const adapter = new ClaudeAgentAdapter({ model: "claude-haiku-4-5" });
      adapter.headers = { "x-aimock-context": "original" };

      const cloned = adapter.clone();
      cloned.headers!["x-aimock-context"] = "mutated";
      cloned.headers!["x-new"] = "added";

      expect(adapter.headers).toEqual({ "x-aimock-context": "original" });
      expect(cloned.headers).not.toBe(adapter.headers);
    });

    it("leaves headers undefined on clone when not set on original", () => {
      const adapter = new ClaudeAgentAdapter({ model: "claude-haiku-4-5" });

      const cloned = adapter.clone();

      expect(cloned.headers).toBeUndefined();
    });
  });

  it("declares headers as a public property", () => {
    const adapter = new ClaudeAgentAdapter();
    // Should be undefined by default
    expect(adapter.headers).toBeUndefined();

    // Should accept assignment
    adapter.headers = { "x-test": "value" };
    expect(adapter.headers).toEqual({ "x-test": "value" });
  });
});

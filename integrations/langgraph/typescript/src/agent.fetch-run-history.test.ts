/**
 * Tests for LangGraphAgent.fetchRunHistory() - SDK Client Mode
 *
 * Tests the fetchRunHistory implementation that uses the LangGraph Platform
 * client's threads.getHistory() method.
 */

import { LangGraphAgent, LangGraphAgentConfig } from "./agent";
import { FetchRunHistoryOptions } from "@ag-ui/client";

// Helper to create a mock LangGraph client
function createMockClient(getHistoryResponse: any[]) {
  return {
    threads: {
      getHistory: jest.fn().mockResolvedValue(getHistoryResponse),
      get: jest.fn().mockResolvedValue({ thread_id: "test-thread" }),
      create: jest.fn().mockResolvedValue({ thread_id: "test-thread" }),
      getState: jest.fn().mockResolvedValue({ values: {} }),
      updateState: jest.fn().mockResolvedValue({}),
    },
    runs: {
      stream: jest.fn(),
      cancel: jest.fn(),
    },
    assistants: {
      search: jest.fn().mockResolvedValue([]),
      getGraph: jest.fn().mockResolvedValue({ nodes: [], edges: [] }),
      getSchemas: jest.fn().mockResolvedValue({}),
    },
  };
}

// Helper to create a test agent with mocked client
function createTestAgent(mockClient: ReturnType<typeof createMockClient>) {
  const config: LangGraphAgentConfig = {
    deploymentUrl: "http://localhost:8000",
    graphId: "test-graph",
    client: mockClient as any,
  };
  return new LangGraphAgent(config);
}

// Helper to call fetchRunHistory (it's protected, so we access it via the class)
async function callFetchRunHistory(
  agent: LangGraphAgent,
  options: FetchRunHistoryOptions
) {
  // Access protected method for testing
  return (agent as any).fetchRunHistory(options);
}

describe("LangGraphAgent.fetchRunHistory", () => {
  describe("Basic Functionality", () => {
    it("should return empty runs when history is empty", async () => {
      const mockClient = createMockClient([]);
      const agent = createTestAgent(mockClient);

      const result = await callFetchRunHistory(agent, { threadId: "thread-1" });

      expect(result).toEqual({ runs: [] });
      expect(mockClient.threads.getHistory).toHaveBeenCalledWith("thread-1");
    });

    it("should return single run with all messages from latest state", async () => {
      const mockClient = createMockClient([
        {
          checkpoint: { thread_id: "thread-1", checkpoint_id: "cp-1" },
          values: {
            messages: [
              { id: "msg-1", type: "human", content: "Hello" },
              { id: "msg-2", type: "ai", content: "Hi there!" },
            ],
          },
        },
      ]);
      const agent = createTestAgent(mockClient);

      const result = await callFetchRunHistory(agent, { threadId: "thread-1" });

      expect(result?.runs).toHaveLength(1);
      expect(result?.runs[0].messages).toHaveLength(2);
      expect(result?.runs[0].messages[0]).toMatchObject({
        id: "msg-1",
        role: "user",
        content: "Hello",
      });
      expect(result?.runs[0].messages[1]).toMatchObject({
        id: "msg-2",
        role: "assistant",
        content: "Hi there!",
      });
    });

    it("should correctly pass threadId to getHistory", async () => {
      const mockClient = createMockClient([]);
      const agent = createTestAgent(mockClient);

      await callFetchRunHistory(agent, { threadId: "my-custom-thread-id" });

      expect(mockClient.threads.getHistory).toHaveBeenCalledWith(
        "my-custom-thread-id"
      );
    });

    it("should use thread_id from checkpoint in runId", async () => {
      const mockClient = createMockClient([
        {
          checkpoint: { thread_id: "checkpoint-thread-id", checkpoint_id: "cp-1" },
          values: {
            messages: [{ id: "msg-1", type: "human", content: "Test" }],
          },
        },
      ]);
      const agent = createTestAgent(mockClient);

      const result = await callFetchRunHistory(agent, { threadId: "thread-1" });

      expect(result?.runs[0].runId).toBe("checkpoint-thread-id");
    });
  });

  describe("Deduplication", () => {
    it("should return identical results on repeated fetchRunHistory calls", async () => {
      const historyResponse = [
        {
          checkpoint: { thread_id: "thread-1", checkpoint_id: "cp-1" },
          values: {
            messages: [
              { id: "msg-1", type: "human", content: "Hello" },
              { id: "msg-2", type: "ai", content: "Hi!" },
            ],
          },
        },
      ];
      const mockClient = createMockClient(historyResponse);
      const agent = createTestAgent(mockClient);

      const result1 = await callFetchRunHistory(agent, { threadId: "thread-1" });
      const result2 = await callFetchRunHistory(agent, { threadId: "thread-1" });

      expect(result1).toEqual(result2);
    });

    it("should maintain stable runIds across calls", async () => {
      const historyResponse = [
        {
          checkpoint: { thread_id: "stable-thread", checkpoint_id: "cp-1" },
          values: {
            messages: [{ id: "msg-1", type: "human", content: "Test" }],
          },
        },
      ];
      const mockClient = createMockClient(historyResponse);
      const agent = createTestAgent(mockClient);

      const result1 = await callFetchRunHistory(agent, { threadId: "thread-1" });
      const result2 = await callFetchRunHistory(agent, { threadId: "thread-1" });

      expect(result1?.runs[0].runId).toBe(result2?.runs[0].runId);
    });

    it("should maintain stable message ids across calls", async () => {
      const historyResponse = [
        {
          checkpoint: { thread_id: "thread-1", checkpoint_id: "cp-1" },
          values: {
            messages: [
              { id: "msg-1", type: "human", content: "Hello" },
              { id: "msg-2", type: "ai", content: "World" },
            ],
          },
        },
      ];
      const mockClient = createMockClient(historyResponse);
      const agent = createTestAgent(mockClient);

      const result1 = await callFetchRunHistory(agent, { threadId: "thread-1" });
      const result2 = await callFetchRunHistory(agent, { threadId: "thread-1" });

      expect(result1?.runs[0].messages[0].id).toBe(result2?.runs[0].messages[0].id);
      expect(result1?.runs[0].messages[1].id).toBe(result2?.runs[0].messages[1].id);
    });
  });

  describe("Message Type Conversion", () => {
    it("should convert human message to user role", async () => {
      const mockClient = createMockClient([
        {
          checkpoint: { thread_id: "thread-1" },
          values: {
            messages: [{ id: "msg-1", type: "human", content: "User message" }],
          },
        },
      ]);
      const agent = createTestAgent(mockClient);

      const result = await callFetchRunHistory(agent, { threadId: "thread-1" });

      expect(result?.runs[0].messages[0].role).toBe("user");
    });

    it("should convert ai message to assistant role", async () => {
      const mockClient = createMockClient([
        {
          checkpoint: { thread_id: "thread-1" },
          values: {
            messages: [{ id: "msg-1", type: "ai", content: "AI response" }],
          },
        },
      ]);
      const agent = createTestAgent(mockClient);

      const result = await callFetchRunHistory(agent, { threadId: "thread-1" });

      expect(result?.runs[0].messages[0].role).toBe("assistant");
    });

    it("should convert system message to system role", async () => {
      const mockClient = createMockClient([
        {
          checkpoint: { thread_id: "thread-1" },
          values: {
            messages: [{ id: "msg-1", type: "system", content: "System prompt" }],
          },
        },
      ]);
      const agent = createTestAgent(mockClient);

      const result = await callFetchRunHistory(agent, { threadId: "thread-1" });

      expect(result?.runs[0].messages[0].role).toBe("system");
    });

    it("should convert tool message to tool role with toolCallId", async () => {
      const mockClient = createMockClient([
        {
          checkpoint: { thread_id: "thread-1" },
          values: {
            messages: [
              {
                id: "msg-1",
                type: "tool",
                content: "Tool result",
                tool_call_id: "tc-123",
              },
            ],
          },
        },
      ]);
      const agent = createTestAgent(mockClient);

      const result = await callFetchRunHistory(agent, { threadId: "thread-1" });

      expect(result?.runs[0].messages[0].role).toBe("tool");
      expect((result?.runs[0].messages[0] as any).toolCallId).toBe("tc-123");
    });

    it("should handle AIMessage with tool_calls array", async () => {
      const mockClient = createMockClient([
        {
          checkpoint: { thread_id: "thread-1" },
          values: {
            messages: [
              {
                id: "msg-1",
                type: "ai",
                content: "",
                tool_calls: [
                  {
                    id: "tc-1",
                    name: "get_weather",
                    args: { location: "NYC" },
                  },
                ],
              },
            ],
          },
        },
      ]);
      const agent = createTestAgent(mockClient);

      const result = await callFetchRunHistory(agent, { threadId: "thread-1" });

      const message = result?.runs[0].messages[0] as any;
      expect(message.role).toBe("assistant");
      expect(message.toolCalls).toHaveLength(1);
      expect(message.toolCalls[0].id).toBe("tc-1");
      expect(message.toolCalls[0].function.name).toBe("get_weather");
      expect(JSON.parse(message.toolCalls[0].function.arguments)).toEqual({
        location: "NYC",
      });
    });
  });

  describe("Edge Cases", () => {
    it("should handle checkpoint with no messages (returns run with empty messages)", async () => {
      const mockClient = createMockClient([
        {
          checkpoint: { thread_id: "thread-1" },
          values: {},
        },
      ]);
      const agent = createTestAgent(mockClient);

      const result = await callFetchRunHistory(agent, { threadId: "thread-1" });

      expect(result?.runs).toHaveLength(1);
      expect(result?.runs[0].messages).toHaveLength(0);
    });

    it("should handle checkpoint without checkpoint data (uses threadId as fallback runId)", async () => {
      const mockClient = createMockClient([
        {
          values: {
            messages: [{ id: "msg-1", type: "human", content: "Test" }],
          },
        },
      ]);
      const agent = createTestAgent(mockClient);

      const result = await callFetchRunHistory(agent, { threadId: "fallback-thread" });

      expect(result?.runs[0].runId).toBe("fallback-thread");
    });

    it("should handle error from client gracefully (returns undefined)", async () => {
      const mockClient = createMockClient([]);
      mockClient.threads.getHistory = jest
        .fn()
        .mockRejectedValue(new Error("Network error"));
      const agent = createTestAgent(mockClient);

      // Suppress console.error for this test
      const consoleSpy = jest.spyOn(console, "error").mockImplementation(() => {});

      const result = await callFetchRunHistory(agent, { threadId: "thread-1" });

      expect(result).toBeUndefined();
      consoleSpy.mockRestore();
    });

    it("should handle null history response", async () => {
      const mockClient = createMockClient([]);
      mockClient.threads.getHistory = jest.fn().mockResolvedValue(null);
      const agent = createTestAgent(mockClient);

      const result = await callFetchRunHistory(agent, { threadId: "thread-1" });

      expect(result).toEqual({ runs: [] });
    });

    it("should handle messages with array content", async () => {
      const mockClient = createMockClient([
        {
          checkpoint: { thread_id: "thread-1" },
          values: {
            messages: [
              {
                id: "msg-1",
                type: "human",
                content: [
                  { type: "text", text: "What is this?" },
                  { type: "image_url", image_url: { url: "https://example.com/img.jpg" } },
                ],
              },
            ],
          },
        },
      ]);
      const agent = createTestAgent(mockClient);

      const result = await callFetchRunHistory(agent, { threadId: "thread-1" });

      expect(result?.runs[0].messages).toHaveLength(1);
      expect(result?.runs[0].messages[0].role).toBe("user");
      // Content should be converted to AG-UI multimodal format
      expect(Array.isArray(result?.runs[0].messages[0].content)).toBe(true);
    });

    it("should handle empty messages array in values", async () => {
      const mockClient = createMockClient([
        {
          checkpoint: { thread_id: "thread-1" },
          values: {
            messages: [],
          },
        },
      ]);
      const agent = createTestAgent(mockClient);

      const result = await callFetchRunHistory(agent, { threadId: "thread-1" });

      expect(result?.runs).toHaveLength(1);
      expect(result?.runs[0].messages).toHaveLength(0);
    });

    it("should handle very long message content", async () => {
      const longContent = "x".repeat(100000);
      const mockClient = createMockClient([
        {
          checkpoint: { thread_id: "thread-1" },
          values: {
            messages: [{ id: "msg-1", type: "human", content: longContent }],
          },
        },
      ]);
      const agent = createTestAgent(mockClient);

      const result = await callFetchRunHistory(agent, { threadId: "thread-1" });

      expect(result?.runs[0].messages[0].content).toBe(longContent);
    });

    it("should handle special characters in content", async () => {
      const specialContent = 'Test with "quotes", <tags>, & symbols\n\t\r';
      const mockClient = createMockClient([
        {
          checkpoint: { thread_id: "thread-1" },
          values: {
            messages: [{ id: "msg-1", type: "human", content: specialContent }],
          },
        },
      ]);
      const agent = createTestAgent(mockClient);

      const result = await callFetchRunHistory(agent, { threadId: "thread-1" });

      expect(result?.runs[0].messages[0].content).toBe(specialContent);
    });
  });

  describe("Multiple Messages", () => {
    it("should handle a complete conversation with multiple message types", async () => {
      const mockClient = createMockClient([
        {
          checkpoint: { thread_id: "thread-1", checkpoint_id: "cp-1" },
          values: {
            messages: [
              { id: "msg-1", type: "system", content: "You are a helpful assistant" },
              { id: "msg-2", type: "human", content: "What is the weather?" },
              {
                id: "msg-3",
                type: "ai",
                content: "",
                tool_calls: [
                  { id: "tc-1", name: "get_weather", args: { location: "NYC" } },
                ],
              },
              { id: "msg-4", type: "tool", content: "Sunny, 72F", tool_call_id: "tc-1" },
              { id: "msg-5", type: "ai", content: "The weather in NYC is sunny and 72F!" },
            ],
          },
        },
      ]);
      const agent = createTestAgent(mockClient);

      const result = await callFetchRunHistory(agent, { threadId: "thread-1" });

      expect(result?.runs).toHaveLength(1);
      expect(result?.runs[0].messages).toHaveLength(5);

      expect(result?.runs[0].messages[0].role).toBe("system");
      expect(result?.runs[0].messages[1].role).toBe("user");
      expect(result?.runs[0].messages[2].role).toBe("assistant");
      expect((result?.runs[0].messages[2] as any).toolCalls).toHaveLength(1);
      expect(result?.runs[0].messages[3].role).toBe("tool");
      expect(result?.runs[0].messages[4].role).toBe("assistant");
    });
  });
});

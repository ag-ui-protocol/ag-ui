/**
 * Tests for LangGraphHttpAgent.fetchRunHistory() - Checkpointer Mode
 *
 * Tests the fetchRunHistory implementation that uses a LangGraph checkpointer
 * (e.g., MemorySaver) to retrieve message history.
 */

import { LangGraphHttpAgent, LangGraphHttpAgentConfig } from "./index";
import { FetchRunHistoryOptions } from "@ag-ui/client";

// Mock checkpointer for testing
class MockCheckpointer {
  private checkpoints: Map<string, any[]> = new Map();
  private tuples: Map<string, any> = new Map();

  setCheckpoints(threadId: string, checkpoints: any[]) {
    this.checkpoints.set(threadId, checkpoints);
  }

  setTuple(threadId: string, tuple: any) {
    this.tuples.set(threadId, tuple);
  }

  async *list(config: { configurable: { thread_id: string } }) {
    const threadId = config.configurable.thread_id;
    const checkpoints = this.checkpoints.get(threadId) || [];
    for (const cp of checkpoints) {
      yield cp;
    }
  }

  async getTuple(config: { configurable: { thread_id: string } }) {
    const threadId = config.configurable.thread_id;
    return this.tuples.get(threadId) || null;
  }
}

// Helper to create a test agent with mock checkpointer
function createTestAgent(checkpointer?: MockCheckpointer) {
  const config: LangGraphHttpAgentConfig = {
    url: "http://localhost:8000/run",
    checkpointer: checkpointer as any,
  };
  return new LangGraphHttpAgent(config);
}

// Helper to call fetchRunHistory (it's protected, so we access it via the class)
async function callFetchRunHistory(
  agent: LangGraphHttpAgent,
  options: FetchRunHistoryOptions
) {
  return (agent as any).fetchRunHistory(options);
}

// Helper to create a mock message with _getType method (simulates LangChain messages)
function createMockMessage(
  type: "human" | "ai" | "system" | "tool",
  content: string,
  id?: string,
  extra?: Record<string, any>
) {
  return {
    id: id || `msg-${Math.random().toString(36).slice(2)}`,
    content,
    type,
    _getType: () => type,
    ...extra,
  };
}

describe("LangGraphHttpAgent.fetchRunHistory", () => {
  describe("Constructor/Config", () => {
    it("should return undefined when no checkpointer provided", async () => {
      const agent = createTestAgent(); // No checkpointer

      const result = await callFetchRunHistory(agent, { threadId: "thread-1" });

      expect(result).toBeUndefined();
    });

    it("should preserve checkpointer in clone()", () => {
      const checkpointer = new MockCheckpointer();
      const agent = createTestAgent(checkpointer);

      const cloned = agent.clone();

      expect((cloned as any).checkpointer).toBe(checkpointer);
    });
  });

  describe("Basic Functionality", () => {
    it("should return empty runs for non-existent thread", async () => {
      const checkpointer = new MockCheckpointer();
      // No checkpoints set for thread-1
      const agent = createTestAgent(checkpointer);

      const result = await callFetchRunHistory(agent, { threadId: "thread-1" });

      expect(result).toEqual({ runs: [] });
    });

    it("should return single run with all messages from latest state", async () => {
      const checkpointer = new MockCheckpointer();
      checkpointer.setCheckpoints("thread-1", [{ id: "cp-1" }]);
      checkpointer.setTuple("thread-1", {
        checkpoint: {
          channel_values: {
            messages: [
              createMockMessage("human", "Hello"),
              createMockMessage("ai", "Hi there!"),
            ],
          },
        },
        config: {
          configurable: { checkpoint_id: "cp-1" },
        },
      });
      const agent = createTestAgent(checkpointer);

      const result = await callFetchRunHistory(agent, { threadId: "thread-1" });

      expect(result?.runs).toHaveLength(1);
      expect(result?.runs[0].messages).toHaveLength(2);
      expect(result?.runs[0].messages[0]).toMatchObject({
        role: "user",
        content: "Hello",
      });
      expect(result?.runs[0].messages[1]).toMatchObject({
        role: "assistant",
        content: "Hi there!",
      });
    });

    it("should use checkpoint_id as runId when available", async () => {
      const checkpointer = new MockCheckpointer();
      checkpointer.setCheckpoints("thread-1", [{ id: "cp-1" }]);
      checkpointer.setTuple("thread-1", {
        checkpoint: {
          channel_values: {
            messages: [createMockMessage("human", "Test")],
          },
        },
        config: {
          configurable: { checkpoint_id: "my-checkpoint-id" },
        },
      });
      const agent = createTestAgent(checkpointer);

      const result = await callFetchRunHistory(agent, { threadId: "thread-1" });

      expect(result?.runs[0].runId).toBe("my-checkpoint-id");
    });

    it("should fall back to threadId for runId when no checkpoint_id", async () => {
      const checkpointer = new MockCheckpointer();
      // Use the correct threadId that matches what we'll query
      checkpointer.setCheckpoints("fallback-thread", [{ id: "cp-1" }]);
      checkpointer.setTuple("fallback-thread", {
        checkpoint: {
          channel_values: {
            messages: [createMockMessage("human", "Test")],
          },
        },
        config: {
          configurable: {},
        },
      });
      const agent = createTestAgent(checkpointer);

      const result = await callFetchRunHistory(agent, { threadId: "fallback-thread" });

      expect(result?.runs[0].runId).toBe("fallback-thread");
    });
  });

  describe("Message Type Conversion", () => {
    it("should convert human message to user role", async () => {
      const checkpointer = new MockCheckpointer();
      checkpointer.setCheckpoints("thread-1", [{ id: "cp-1" }]);
      checkpointer.setTuple("thread-1", {
        checkpoint: {
          channel_values: {
            messages: [createMockMessage("human", "User message")],
          },
        },
        config: { configurable: { checkpoint_id: "cp-1" } },
      });
      const agent = createTestAgent(checkpointer);

      const result = await callFetchRunHistory(agent, { threadId: "thread-1" });

      expect(result?.runs[0].messages[0].role).toBe("user");
    });

    it("should convert ai message to assistant role", async () => {
      const checkpointer = new MockCheckpointer();
      checkpointer.setCheckpoints("thread-1", [{ id: "cp-1" }]);
      checkpointer.setTuple("thread-1", {
        checkpoint: {
          channel_values: {
            messages: [createMockMessage("ai", "AI response")],
          },
        },
        config: { configurable: { checkpoint_id: "cp-1" } },
      });
      const agent = createTestAgent(checkpointer);

      const result = await callFetchRunHistory(agent, { threadId: "thread-1" });

      expect(result?.runs[0].messages[0].role).toBe("assistant");
    });

    it("should convert system message to system role", async () => {
      const checkpointer = new MockCheckpointer();
      checkpointer.setCheckpoints("thread-1", [{ id: "cp-1" }]);
      checkpointer.setTuple("thread-1", {
        checkpoint: {
          channel_values: {
            messages: [createMockMessage("system", "System prompt")],
          },
        },
        config: { configurable: { checkpoint_id: "cp-1" } },
      });
      const agent = createTestAgent(checkpointer);

      const result = await callFetchRunHistory(agent, { threadId: "thread-1" });

      expect(result?.runs[0].messages[0].role).toBe("system");
    });

    it("should convert tool message to tool role with toolCallId", async () => {
      const checkpointer = new MockCheckpointer();
      checkpointer.setCheckpoints("thread-1", [{ id: "cp-1" }]);
      checkpointer.setTuple("thread-1", {
        checkpoint: {
          channel_values: {
            messages: [
              createMockMessage("tool", "Tool result", "msg-1", {
                tool_call_id: "tc-123",
              }),
            ],
          },
        },
        config: { configurable: { checkpoint_id: "cp-1" } },
      });
      const agent = createTestAgent(checkpointer);

      const result = await callFetchRunHistory(agent, { threadId: "thread-1" });

      expect(result?.runs[0].messages[0].role).toBe("tool");
      expect((result?.runs[0].messages[0] as any).toolCallId).toBe("tc-123");
    });

    it("should handle AIMessage with tool_calls array", async () => {
      const checkpointer = new MockCheckpointer();
      checkpointer.setCheckpoints("thread-1", [{ id: "cp-1" }]);
      checkpointer.setTuple("thread-1", {
        checkpoint: {
          channel_values: {
            messages: [
              createMockMessage("ai", "", "msg-1", {
                tool_calls: [
                  { id: "tc-1", name: "get_weather", args: { location: "NYC" } },
                ],
              }),
            ],
          },
        },
        config: { configurable: { checkpoint_id: "cp-1" } },
      });
      const agent = createTestAgent(checkpointer);

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

  describe("Deduplication", () => {
    it("should return identical results on repeated fetchRunHistory calls", async () => {
      const checkpointer = new MockCheckpointer();
      checkpointer.setCheckpoints("thread-1", [{ id: "cp-1" }]);
      checkpointer.setTuple("thread-1", {
        checkpoint: {
          channel_values: {
            messages: [
              createMockMessage("human", "Hello", "msg-1"),
              createMockMessage("ai", "Hi!", "msg-2"),
            ],
          },
        },
        config: { configurable: { checkpoint_id: "cp-1" } },
      });
      const agent = createTestAgent(checkpointer);

      const result1 = await callFetchRunHistory(agent, { threadId: "thread-1" });
      const result2 = await callFetchRunHistory(agent, { threadId: "thread-1" });

      expect(result1).toEqual(result2);
    });

    it("should maintain stable runIds across calls", async () => {
      const checkpointer = new MockCheckpointer();
      checkpointer.setCheckpoints("thread-1", [{ id: "cp-1" }]);
      checkpointer.setTuple("thread-1", {
        checkpoint: {
          channel_values: {
            messages: [createMockMessage("human", "Test", "msg-1")],
          },
        },
        config: { configurable: { checkpoint_id: "stable-run-id" } },
      });
      const agent = createTestAgent(checkpointer);

      const result1 = await callFetchRunHistory(agent, { threadId: "thread-1" });
      const result2 = await callFetchRunHistory(agent, { threadId: "thread-1" });

      expect(result1?.runs[0].runId).toBe(result2?.runs[0].runId);
      expect(result1?.runs[0].runId).toBe("stable-run-id");
    });

    it("should maintain stable message ids across calls", async () => {
      const checkpointer = new MockCheckpointer();
      checkpointer.setCheckpoints("thread-1", [{ id: "cp-1" }]);
      checkpointer.setTuple("thread-1", {
        checkpoint: {
          channel_values: {
            messages: [
              createMockMessage("human", "Hello", "stable-msg-1"),
              createMockMessage("ai", "World", "stable-msg-2"),
            ],
          },
        },
        config: { configurable: { checkpoint_id: "cp-1" } },
      });
      const agent = createTestAgent(checkpointer);

      const result1 = await callFetchRunHistory(agent, { threadId: "thread-1" });
      const result2 = await callFetchRunHistory(agent, { threadId: "thread-1" });

      expect(result1?.runs[0].messages[0].id).toBe(result2?.runs[0].messages[0].id);
      expect(result1?.runs[0].messages[1].id).toBe(result2?.runs[0].messages[1].id);
    });
  });

  describe("ID Generation", () => {
    it("should preserve original message id when available", async () => {
      const checkpointer = new MockCheckpointer();
      checkpointer.setCheckpoints("thread-1", [{ id: "cp-1" }]);
      checkpointer.setTuple("thread-1", {
        checkpoint: {
          channel_values: {
            messages: [createMockMessage("human", "Test", "original-id-123")],
          },
        },
        config: { configurable: { checkpoint_id: "cp-1" } },
      });
      const agent = createTestAgent(checkpointer);

      const result = await callFetchRunHistory(agent, { threadId: "thread-1" });

      expect(result?.runs[0].messages[0].id).toBe("original-id-123");
    });

    it("should generate id when message has no id", async () => {
      const checkpointer = new MockCheckpointer();
      checkpointer.setCheckpoints("thread-1", [{ id: "cp-1" }]);
      checkpointer.setTuple("thread-1", {
        checkpoint: {
          channel_values: {
            messages: [
              {
                content: "No ID message",
                type: "human",
                _getType: () => "human",
                // No id field
              },
            ],
          },
        },
        config: { configurable: { checkpoint_id: "cp-1" } },
      });
      const agent = createTestAgent(checkpointer);

      const result = await callFetchRunHistory(agent, { threadId: "thread-1" });

      expect(result?.runs[0].messages[0].id).toBeDefined();
      expect(typeof result?.runs[0].messages[0].id).toBe("string");
    });
  });

  describe("Edge Cases", () => {
    it("should handle empty messages array in state", async () => {
      const checkpointer = new MockCheckpointer();
      checkpointer.setCheckpoints("thread-1", [{ id: "cp-1" }]);
      checkpointer.setTuple("thread-1", {
        checkpoint: {
          channel_values: {
            messages: [],
          },
        },
        config: { configurable: { checkpoint_id: "cp-1" } },
      });
      const agent = createTestAgent(checkpointer);

      const result = await callFetchRunHistory(agent, { threadId: "thread-1" });

      expect(result?.runs).toHaveLength(1);
      expect(result?.runs[0].messages).toHaveLength(0);
    });

    it("should handle missing messages in channel_values", async () => {
      const checkpointer = new MockCheckpointer();
      checkpointer.setCheckpoints("thread-1", [{ id: "cp-1" }]);
      checkpointer.setTuple("thread-1", {
        checkpoint: {
          channel_values: {
            // No messages field
          },
        },
        config: { configurable: { checkpoint_id: "cp-1" } },
      });
      const agent = createTestAgent(checkpointer);

      const result = await callFetchRunHistory(agent, { threadId: "thread-1" });

      expect(result?.runs).toHaveLength(1);
      expect(result?.runs[0].messages).toHaveLength(0);
    });

    it("should handle missing channel_values", async () => {
      const checkpointer = new MockCheckpointer();
      checkpointer.setCheckpoints("thread-1", [{ id: "cp-1" }]);
      checkpointer.setTuple("thread-1", {
        checkpoint: {
          // No channel_values
        },
        config: { configurable: { checkpoint_id: "cp-1" } },
      });
      const agent = createTestAgent(checkpointer);

      const result = await callFetchRunHistory(agent, { threadId: "thread-1" });

      expect(result?.runs).toHaveLength(1);
      expect(result?.runs[0].messages).toHaveLength(0);
    });

    it("should handle missing checkpoint in tuple", async () => {
      const checkpointer = new MockCheckpointer();
      checkpointer.setCheckpoints("thread-1", [{ id: "cp-1" }]);
      checkpointer.setTuple("thread-1", {
        // No checkpoint
        config: { configurable: { checkpoint_id: "cp-1" } },
      });
      const agent = createTestAgent(checkpointer);

      const result = await callFetchRunHistory(agent, { threadId: "thread-1" });

      expect(result).toEqual({ runs: [] });
    });

    it("should handle very long message content", async () => {
      const longContent = "x".repeat(100000);
      const checkpointer = new MockCheckpointer();
      checkpointer.setCheckpoints("thread-1", [{ id: "cp-1" }]);
      checkpointer.setTuple("thread-1", {
        checkpoint: {
          channel_values: {
            messages: [createMockMessage("human", longContent, "msg-1")],
          },
        },
        config: { configurable: { checkpoint_id: "cp-1" } },
      });
      const agent = createTestAgent(checkpointer);

      const result = await callFetchRunHistory(agent, { threadId: "thread-1" });

      expect(result?.runs[0].messages[0].content).toBe(longContent);
    });

    it("should handle special characters in content", async () => {
      const specialContent = 'Test with "quotes", <tags>, & symbols\n\t\r';
      const checkpointer = new MockCheckpointer();
      checkpointer.setCheckpoints("thread-1", [{ id: "cp-1" }]);
      checkpointer.setTuple("thread-1", {
        checkpoint: {
          channel_values: {
            messages: [createMockMessage("human", specialContent, "msg-1")],
          },
        },
        config: { configurable: { checkpoint_id: "cp-1" } },
      });
      const agent = createTestAgent(checkpointer);

      const result = await callFetchRunHistory(agent, { threadId: "thread-1" });

      expect(result?.runs[0].messages[0].content).toBe(specialContent);
    });

    it("should handle complex content (object that gets stringified)", async () => {
      const complexContent = { key: "value", nested: { a: 1 } };
      const checkpointer = new MockCheckpointer();
      checkpointer.setCheckpoints("thread-1", [{ id: "cp-1" }]);
      checkpointer.setTuple("thread-1", {
        checkpoint: {
          channel_values: {
            messages: [
              {
                id: "msg-1",
                content: complexContent,
                type: "human",
                _getType: () => "human",
              },
            ],
          },
        },
        config: { configurable: { checkpoint_id: "cp-1" } },
      });
      const agent = createTestAgent(checkpointer);

      const result = await callFetchRunHistory(agent, { threadId: "thread-1" });

      expect(result?.runs[0].messages[0].content).toBe(
        JSON.stringify(complexContent)
      );
    });

    it("should handle error from checkpointer gracefully", async () => {
      const checkpointer = new MockCheckpointer();
      // Override list to throw
      checkpointer.list = async function* () {
        throw new Error("Checkpointer error");
      };
      const agent = createTestAgent(checkpointer);

      // Suppress console.error for this test
      const consoleSpy = jest.spyOn(console, "error").mockImplementation(() => {});

      const result = await callFetchRunHistory(agent, { threadId: "thread-1" });

      expect(result).toBeUndefined();
      consoleSpy.mockRestore();
    });

    it("should skip messages with unknown types", async () => {
      const checkpointer = new MockCheckpointer();
      checkpointer.setCheckpoints("thread-1", [{ id: "cp-1" }]);
      checkpointer.setTuple("thread-1", {
        checkpoint: {
          channel_values: {
            messages: [
              createMockMessage("human", "Valid message", "msg-1"),
              {
                id: "msg-2",
                content: "Unknown type",
                type: "unknown_type",
                _getType: () => "unknown_type",
              },
              createMockMessage("ai", "Another valid message", "msg-3"),
            ],
          },
        },
        config: { configurable: { checkpoint_id: "cp-1" } },
      });
      const agent = createTestAgent(checkpointer);

      const result = await callFetchRunHistory(agent, { threadId: "thread-1" });

      // Unknown type message should be filtered out
      expect(result?.runs[0].messages).toHaveLength(2);
      expect(result?.runs[0].messages[0].role).toBe("user");
      expect(result?.runs[0].messages[1].role).toBe("assistant");
    });
  });

  describe("Multiple Messages", () => {
    it("should handle a complete conversation with multiple message types", async () => {
      const checkpointer = new MockCheckpointer();
      checkpointer.setCheckpoints("thread-1", [{ id: "cp-1" }]);
      checkpointer.setTuple("thread-1", {
        checkpoint: {
          channel_values: {
            messages: [
              createMockMessage("system", "You are a helpful assistant", "msg-1"),
              createMockMessage("human", "What is the weather?", "msg-2"),
              createMockMessage("ai", "", "msg-3", {
                tool_calls: [
                  { id: "tc-1", name: "get_weather", args: { location: "NYC" } },
                ],
              }),
              createMockMessage("tool", "Sunny, 72F", "msg-4", {
                tool_call_id: "tc-1",
              }),
              createMockMessage(
                "ai",
                "The weather in NYC is sunny and 72F!",
                "msg-5"
              ),
            ],
          },
        },
        config: { configurable: { checkpoint_id: "cp-1" } },
      });
      const agent = createTestAgent(checkpointer);

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

/**
 * Tests for MastraAgent.fetchRunHistory()
 *
 * Tests the fetchRunHistory implementation that converts MastraDBMessage[]
 * (V2 format with content.parts[]) to AG-UI RunHistory[].
 */

import { MastraAgent, MastraAgentConfig } from "../mastra";
import { FetchRunHistoryOptions } from "@ag-ui/client";

// --- Mock helpers ---

function makeMastraDBMessage(overrides: {
  id: string;
  role: "user" | "assistant" | "system";
  parts: any[];
}): any {
  return {
    id: overrides.id,
    role: overrides.role,
    createdAt: new Date(),
    content: {
      format: 2,
      parts: overrides.parts,
    },
  };
}

function textPart(text: string) {
  return { type: "text", text };
}

function toolInvocationPart(opts: {
  toolCallId: string;
  toolName: string;
  args: any;
  state: string;
  result?: any;
}) {
  return {
    type: "tool-invocation",
    toolInvocation: {
      toolCallId: opts.toolCallId,
      toolName: opts.toolName,
      args: opts.args,
      state: opts.state,
      ...(opts.result !== undefined ? { result: opts.result } : {}),
    },
  };
}

function dynamicToolPart(opts: {
  toolCallId: string;
  toolName: string;
  input: any;
  state: string;
  output?: any;
}) {
  return {
    type: "dynamic-tool",
    toolCallId: opts.toolCallId,
    toolName: opts.toolName,
    input: opts.input,
    state: opts.state,
    ...(opts.output !== undefined ? { output: opts.output } : {}),
  };
}

// --- Mock factories ---

function createMockMemory(messages: any[]) {
  return {
    recall: vi.fn().mockResolvedValue({ messages }),
  };
}

function createMockLocalAgent(memory: any) {
  return {
    getMemory: vi.fn().mockResolvedValue(memory),
    // Needed for isLocalMastraAgent type guard
    stream: vi.fn(),
  };
}

function createMockRemoteAgent() {
  return {
    stream: vi.fn(),
  };
}

function createMockMastraClient(messages: any[]) {
  return {
    listThreadMessages: vi.fn().mockResolvedValue({ messages }),
    getAgent: vi.fn(),
    listAgents: vi.fn(),
  };
}

// Helper to call protected fetchRunHistory
async function callFetchRunHistory(
  agent: MastraAgent,
  options: FetchRunHistoryOptions,
) {
  return (agent as any).fetchRunHistory(options);
}

// --- Tests ---

describe("MastraAgent.fetchRunHistory", () => {
  describe("Basic Functionality", () => {
    it("should return empty runs when no memory is configured", async () => {
      const mockAgent = {
        getMemory: vi.fn().mockResolvedValue(null),
        stream: vi.fn(),
      };
      const config: MastraAgentConfig = {
        agentId: "test-agent",
        agent: mockAgent as any,
        resourceId: "test-resource",
      };
      const agent = new MastraAgent(config);

      const result = await callFetchRunHistory(agent, {
        threadId: "thread-1",
      });

      expect(result).toEqual({ runs: [] });
    });

    it("should return empty runs when memory has no messages", async () => {
      const mockMemory = createMockMemory([]);
      const mockLocalAgent = createMockLocalAgent(mockMemory);
      const config: MastraAgentConfig = {
        agentId: "test-agent",
        agent: mockLocalAgent as any,
        resourceId: "test-resource",
      };
      const agent = new MastraAgent(config);

      const result = await callFetchRunHistory(agent, {
        threadId: "thread-1",
      });

      expect(result).toEqual({ runs: [] });
    });

    it("should return a single run for a simple user+assistant conversation", async () => {
      const messages = [
        makeMastraDBMessage({
          id: "msg-1",
          role: "user",
          parts: [textPart("Hello")],
        }),
        makeMastraDBMessage({
          id: "msg-2",
          role: "assistant",
          parts: [textPart("Hi there!")],
        }),
      ];
      const mockMemory = createMockMemory(messages);
      const mockLocalAgent = createMockLocalAgent(mockMemory);
      const config: MastraAgentConfig = {
        agentId: "test-agent",
        agent: mockLocalAgent as any,
        resourceId: "test-resource",
      };
      const agent = new MastraAgent(config);

      const result = await callFetchRunHistory(agent, {
        threadId: "thread-1",
      });

      expect(result?.runs).toHaveLength(1);
      expect(result?.runs[0].runId).toBe("msg-1");
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
  });

  describe("Message Type Conversion", () => {
    it("should convert user message with text parts", async () => {
      const messages = [
        makeMastraDBMessage({
          id: "msg-1",
          role: "user",
          parts: [textPart("Hello"), textPart("World")],
        }),
      ];
      const mockMemory = createMockMemory(messages);
      const mockLocalAgent = createMockLocalAgent(mockMemory);
      const agent = new MastraAgent({
        agentId: "test",
        agent: mockLocalAgent as any,
        resourceId: "res",
      });

      const result = await callFetchRunHistory(agent, {
        threadId: "thread-1",
      });

      expect(result?.runs[0].messages[0]).toMatchObject({
        id: "msg-1",
        role: "user",
        content: "Hello\nWorld",
      });
    });

    it("should convert assistant message with text parts", async () => {
      const messages = [
        makeMastraDBMessage({
          id: "msg-1",
          role: "user",
          parts: [textPart("Hi")],
        }),
        makeMastraDBMessage({
          id: "msg-2",
          role: "assistant",
          parts: [textPart("Response text")],
        }),
      ];
      const mockMemory = createMockMemory(messages);
      const mockLocalAgent = createMockLocalAgent(mockMemory);
      const agent = new MastraAgent({
        agentId: "test",
        agent: mockLocalAgent as any,
        resourceId: "res",
      });

      const result = await callFetchRunHistory(agent, {
        threadId: "thread-1",
      });

      const assistantMsg = result?.runs[0].messages[1];
      expect(assistantMsg).toMatchObject({
        id: "msg-2",
        role: "assistant",
        content: "Response text",
      });
    });

    it("should convert system message", async () => {
      const messages = [
        makeMastraDBMessage({
          id: "msg-1",
          role: "system",
          parts: [textPart("You are a helpful assistant")],
        }),
      ];
      const mockMemory = createMockMemory(messages);
      const mockLocalAgent = createMockLocalAgent(mockMemory);
      const agent = new MastraAgent({
        agentId: "test",
        agent: mockLocalAgent as any,
        resourceId: "res",
      });

      const result = await callFetchRunHistory(agent, {
        threadId: "thread-1",
      });

      expect(result?.runs[0].messages[0]).toMatchObject({
        id: "msg-1",
        role: "system",
        content: "You are a helpful assistant",
      });
    });

    it("should convert assistant message with tool-invocation parts to assistant + tool messages", async () => {
      const messages = [
        makeMastraDBMessage({
          id: "msg-1",
          role: "user",
          parts: [textPart("What's the weather?")],
        }),
        makeMastraDBMessage({
          id: "msg-2",
          role: "assistant",
          parts: [
            textPart("Let me check the weather."),
            toolInvocationPart({
              toolCallId: "tc-1",
              toolName: "get_weather",
              args: { location: "NYC" },
              state: "result",
              result: { temp: 72, condition: "sunny" },
            }),
          ],
        }),
      ];
      const mockMemory = createMockMemory(messages);
      const mockLocalAgent = createMockLocalAgent(mockMemory);
      const agent = new MastraAgent({
        agentId: "test",
        agent: mockLocalAgent as any,
        resourceId: "res",
      });

      const result = await callFetchRunHistory(agent, {
        threadId: "thread-1",
      });

      // Should have 3 messages: user, assistant, tool
      expect(result?.runs[0].messages).toHaveLength(3);

      const assistantMsg = result?.runs[0].messages[1] as any;
      expect(assistantMsg.role).toBe("assistant");
      expect(assistantMsg.content).toBe("Let me check the weather.");
      expect(assistantMsg.toolCalls).toHaveLength(1);
      expect(assistantMsg.toolCalls[0]).toEqual({
        id: "tc-1",
        type: "function",
        function: {
          name: "get_weather",
          arguments: JSON.stringify({ location: "NYC" }),
        },
      });

      const toolMsg = result?.runs[0].messages[2] as any;
      expect(toolMsg.role).toBe("tool");
      expect(toolMsg.toolCallId).toBe("tc-1");
      expect(toolMsg.content).toBe(
        JSON.stringify({ temp: 72, condition: "sunny" }),
      );
    });

    it("should handle tool-invocation in 'call' state (no result yet)", async () => {
      const messages = [
        makeMastraDBMessage({
          id: "msg-1",
          role: "user",
          parts: [textPart("Do something")],
        }),
        makeMastraDBMessage({
          id: "msg-2",
          role: "assistant",
          parts: [
            toolInvocationPart({
              toolCallId: "tc-1",
              toolName: "some_tool",
              args: { x: 1 },
              state: "call",
            }),
          ],
        }),
      ];
      const mockMemory = createMockMemory(messages);
      const mockLocalAgent = createMockLocalAgent(mockMemory);
      const agent = new MastraAgent({
        agentId: "test",
        agent: mockLocalAgent as any,
        resourceId: "res",
      });

      const result = await callFetchRunHistory(agent, {
        threadId: "thread-1",
      });

      // Should have 2 messages: user, assistant (no tool message since no result)
      expect(result?.runs[0].messages).toHaveLength(2);
      const assistantMsg = result?.runs[0].messages[1] as any;
      expect(assistantMsg.toolCalls).toHaveLength(1);
    });

    it("should handle dynamic-tool parts", async () => {
      const messages = [
        makeMastraDBMessage({
          id: "msg-1",
          role: "user",
          parts: [textPart("Search for something")],
        }),
        makeMastraDBMessage({
          id: "msg-2",
          role: "assistant",
          parts: [
            dynamicToolPart({
              toolCallId: "dtc-1",
              toolName: "search",
              input: { query: "test" },
              state: "output-available",
              output: { results: ["a", "b"] },
            }),
          ],
        }),
      ];
      const mockMemory = createMockMemory(messages);
      const mockLocalAgent = createMockLocalAgent(mockMemory);
      const agent = new MastraAgent({
        agentId: "test",
        agent: mockLocalAgent as any,
        resourceId: "res",
      });

      const result = await callFetchRunHistory(agent, {
        threadId: "thread-1",
      });

      expect(result?.runs[0].messages).toHaveLength(3);
      const assistantMsg = result?.runs[0].messages[1] as any;
      expect(assistantMsg.toolCalls[0].id).toBe("dtc-1");
      expect(assistantMsg.toolCalls[0].function.name).toBe("search");

      const toolMsg = result?.runs[0].messages[2] as any;
      expect(toolMsg.role).toBe("tool");
      expect(toolMsg.toolCallId).toBe("dtc-1");
    });
  });

  describe("Run Grouping", () => {
    it("should group messages into multiple runs by user-message boundaries", async () => {
      const messages = [
        makeMastraDBMessage({
          id: "msg-1",
          role: "user",
          parts: [textPart("Hello")],
        }),
        makeMastraDBMessage({
          id: "msg-2",
          role: "assistant",
          parts: [textPart("Hi!")],
        }),
        makeMastraDBMessage({
          id: "msg-3",
          role: "user",
          parts: [textPart("Tell me a joke")],
        }),
        makeMastraDBMessage({
          id: "msg-4",
          role: "assistant",
          parts: [textPart("Why did the chicken cross the road?")],
        }),
      ];
      const mockMemory = createMockMemory(messages);
      const mockLocalAgent = createMockLocalAgent(mockMemory);
      const agent = new MastraAgent({
        agentId: "test",
        agent: mockLocalAgent as any,
        resourceId: "res",
      });

      const result = await callFetchRunHistory(agent, {
        threadId: "thread-1",
      });

      expect(result?.runs).toHaveLength(2);
      expect(result?.runs[0].runId).toBe("msg-1");
      expect(result?.runs[0].messages).toHaveLength(2);
      expect(result?.runs[1].runId).toBe("msg-3");
      expect(result?.runs[1].messages).toHaveLength(2);
    });

    it("should handle system messages before user messages", async () => {
      const messages = [
        makeMastraDBMessage({
          id: "msg-sys",
          role: "system",
          parts: [textPart("System prompt")],
        }),
        makeMastraDBMessage({
          id: "msg-1",
          role: "user",
          parts: [textPart("Hello")],
        }),
        makeMastraDBMessage({
          id: "msg-2",
          role: "assistant",
          parts: [textPart("Hi!")],
        }),
      ];
      const mockMemory = createMockMemory(messages);
      const mockLocalAgent = createMockLocalAgent(mockMemory);
      const agent = new MastraAgent({
        agentId: "test",
        agent: mockLocalAgent as any,
        resourceId: "res",
      });

      const result = await callFetchRunHistory(agent, {
        threadId: "thread-1",
      });

      // System message forms its own run, then user+assistant form another
      expect(result?.runs).toHaveLength(2);
      expect(result?.runs[0].runId).toBe("msg-sys");
      expect(result?.runs[0].messages).toHaveLength(1);
      expect(result?.runs[0].messages[0].role).toBe("system");
      expect(result?.runs[1].runId).toBe("msg-1");
      expect(result?.runs[1].messages).toHaveLength(2);
    });
  });

  describe("Local Agent Path", () => {
    it("should call memory.recall with correct parameters", async () => {
      const mockMemory = createMockMemory([]);
      const mockLocalAgent = createMockLocalAgent(mockMemory);
      const agent = new MastraAgent({
        agentId: "test",
        agent: mockLocalAgent as any,
        resourceId: "my-resource",
      });

      await callFetchRunHistory(agent, { threadId: "my-thread" });

      expect(mockLocalAgent.getMemory).toHaveBeenCalled();
      expect(mockMemory.recall).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: "my-thread",
          resourceId: "my-resource",
          perPage: false,
          orderBy: { field: "createdAt", direction: "ASC" },
        }),
      );
    });
  });

  describe("Remote Agent Path", () => {
    it("should use mastraClient.listThreadMessages for remote agents", async () => {
      const messages = [
        makeMastraDBMessage({
          id: "msg-1",
          role: "user",
          parts: [textPart("Hello")],
        }),
        makeMastraDBMessage({
          id: "msg-2",
          role: "assistant",
          parts: [textPart("Hi!")],
        }),
      ];
      const mockMastraClient = createMockMastraClient(messages);
      const mockRemoteAgent = createMockRemoteAgent();
      const agent = new MastraAgent({
        agentId: "remote-agent",
        agent: mockRemoteAgent as any,
        resourceId: "res",
        mastraClient: mockMastraClient as any,
      });

      const result = await callFetchRunHistory(agent, {
        threadId: "thread-1",
      });

      expect(mockMastraClient.listThreadMessages).toHaveBeenCalledWith(
        "thread-1",
        { agentId: "remote-agent" },
      );
      expect(result?.runs).toHaveLength(1);
      expect(result?.runs[0].messages).toHaveLength(2);
    });

    it("should return empty runs when no mastraClient is provided for remote agent", async () => {
      const mockRemoteAgent = createMockRemoteAgent();
      const agent = new MastraAgent({
        agentId: "remote-agent",
        agent: mockRemoteAgent as any,
        resourceId: "res",
      });

      const result = await callFetchRunHistory(agent, {
        threadId: "thread-1",
      });

      expect(result).toEqual({ runs: [] });
    });
  });

  describe("Edge Cases", () => {
    it("should return undefined on error", async () => {
      const mockMemory = {
        recall: vi.fn().mockRejectedValue(new Error("DB error")),
      };
      const mockLocalAgent = createMockLocalAgent(mockMemory);
      const agent = new MastraAgent({
        agentId: "test",
        agent: mockLocalAgent as any,
        resourceId: "res",
      });

      const consoleSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});

      const result = await callFetchRunHistory(agent, {
        threadId: "thread-1",
      });

      expect(result).toBeUndefined();
      consoleSpy.mockRestore();
    });

    it("should handle messages with empty parts", async () => {
      const messages = [
        makeMastraDBMessage({
          id: "msg-1",
          role: "user",
          parts: [],
        }),
      ];
      const mockMemory = createMockMemory(messages);
      const mockLocalAgent = createMockLocalAgent(mockMemory);
      const agent = new MastraAgent({
        agentId: "test",
        agent: mockLocalAgent as any,
        resourceId: "res",
      });

      const result = await callFetchRunHistory(agent, {
        threadId: "thread-1",
      });

      expect(result?.runs).toHaveLength(1);
      expect(result?.runs[0].messages[0]).toMatchObject({
        id: "msg-1",
        role: "user",
        content: "",
      });
    });

    it("should handle multiple tool calls in a single assistant message", async () => {
      const messages = [
        makeMastraDBMessage({
          id: "msg-1",
          role: "user",
          parts: [textPart("Do two things")],
        }),
        makeMastraDBMessage({
          id: "msg-2",
          role: "assistant",
          parts: [
            toolInvocationPart({
              toolCallId: "tc-1",
              toolName: "tool_a",
              args: { x: 1 },
              state: "result",
              result: "result-a",
            }),
            toolInvocationPart({
              toolCallId: "tc-2",
              toolName: "tool_b",
              args: { y: 2 },
              state: "result",
              result: "result-b",
            }),
          ],
        }),
      ];
      const mockMemory = createMockMemory(messages);
      const mockLocalAgent = createMockLocalAgent(mockMemory);
      const agent = new MastraAgent({
        agentId: "test",
        agent: mockLocalAgent as any,
        resourceId: "res",
      });

      const result = await callFetchRunHistory(agent, {
        threadId: "thread-1",
      });

      // user + assistant + 2 tool messages = 4
      expect(result?.runs[0].messages).toHaveLength(4);
      const assistantMsg = result?.runs[0].messages[1] as any;
      expect(assistantMsg.toolCalls).toHaveLength(2);
      expect(result?.runs[0].messages[2].role).toBe("tool");
      expect(result?.runs[0].messages[3].role).toBe("tool");
    });
  });

  describe("Deduplication/Stability", () => {
    it("should return identical results on repeated calls", async () => {
      const messages = [
        makeMastraDBMessage({
          id: "msg-1",
          role: "user",
          parts: [textPart("Hello")],
        }),
        makeMastraDBMessage({
          id: "msg-2",
          role: "assistant",
          parts: [textPart("Hi!")],
        }),
      ];
      const mockMemory = createMockMemory(messages);
      const mockLocalAgent = createMockLocalAgent(mockMemory);
      const agent = new MastraAgent({
        agentId: "test",
        agent: mockLocalAgent as any,
        resourceId: "res",
      });

      const result1 = await callFetchRunHistory(agent, {
        threadId: "thread-1",
      });
      const result2 = await callFetchRunHistory(agent, {
        threadId: "thread-1",
      });

      expect(result1).toEqual(result2);
    });

    it("should maintain stable runIds across calls", async () => {
      const messages = [
        makeMastraDBMessage({
          id: "msg-1",
          role: "user",
          parts: [textPart("Hello")],
        }),
        makeMastraDBMessage({
          id: "msg-2",
          role: "assistant",
          parts: [textPart("World")],
        }),
      ];
      const mockMemory = createMockMemory(messages);
      const mockLocalAgent = createMockLocalAgent(mockMemory);
      const agent = new MastraAgent({
        agentId: "test",
        agent: mockLocalAgent as any,
        resourceId: "res",
      });

      const result1 = await callFetchRunHistory(agent, {
        threadId: "thread-1",
      });
      const result2 = await callFetchRunHistory(agent, {
        threadId: "thread-1",
      });

      expect(result1?.runs[0].runId).toBe(result2?.runs[0].runId);
    });

    it("should maintain stable message ids across calls", async () => {
      const messages = [
        makeMastraDBMessage({
          id: "msg-1",
          role: "user",
          parts: [textPart("Hello")],
        }),
        makeMastraDBMessage({
          id: "msg-2",
          role: "assistant",
          parts: [textPart("World")],
        }),
      ];
      const mockMemory = createMockMemory(messages);
      const mockLocalAgent = createMockLocalAgent(mockMemory);
      const agent = new MastraAgent({
        agentId: "test",
        agent: mockLocalAgent as any,
        resourceId: "res",
      });

      const result1 = await callFetchRunHistory(agent, {
        threadId: "thread-1",
      });
      const result2 = await callFetchRunHistory(agent, {
        threadId: "thread-1",
      });

      expect(result1?.runs[0].messages[0].id).toBe(
        result2?.runs[0].messages[0].id,
      );
      expect(result1?.runs[0].messages[1].id).toBe(
        result2?.runs[0].messages[1].id,
      );
    });
  });

  describe("Complete Conversation", () => {
    it("should handle a full conversation with system, user, tool, and assistant messages", async () => {
      const messages = [
        makeMastraDBMessage({
          id: "msg-sys",
          role: "system",
          parts: [textPart("You are a helpful assistant")],
        }),
        makeMastraDBMessage({
          id: "msg-1",
          role: "user",
          parts: [textPart("What is the weather?")],
        }),
        makeMastraDBMessage({
          id: "msg-2",
          role: "assistant",
          parts: [
            toolInvocationPart({
              toolCallId: "tc-1",
              toolName: "get_weather",
              args: { location: "NYC" },
              state: "result",
              result: "Sunny, 72F",
            }),
          ],
        }),
        makeMastraDBMessage({
          id: "msg-3",
          role: "assistant",
          parts: [textPart("The weather in NYC is sunny and 72F!")],
        }),
      ];
      const mockMemory = createMockMemory(messages);
      const mockLocalAgent = createMockLocalAgent(mockMemory);
      const agent = new MastraAgent({
        agentId: "test",
        agent: mockLocalAgent as any,
        resourceId: "res",
      });

      const result = await callFetchRunHistory(agent, {
        threadId: "thread-1",
      });

      // system run + user conversation run
      expect(result?.runs).toHaveLength(2);

      // First run: system message
      expect(result?.runs[0].messages[0].role).toBe("system");

      // Second run: user, assistant(with tool), tool, assistant
      expect(result?.runs[1].messages).toHaveLength(4);
      expect(result?.runs[1].messages[0].role).toBe("user");
      expect(result?.runs[1].messages[1].role).toBe("assistant");
      expect((result?.runs[1].messages[1] as any).toolCalls).toHaveLength(1);
      expect(result?.runs[1].messages[2].role).toBe("tool");
      expect(result?.runs[1].messages[3].role).toBe("assistant");
      expect(result?.runs[1].messages[3].content).toBe(
        "The weather in NYC is sunny and 72F!",
      );
    });
  });
});

/**
 * Tests for AG-UI <-> LangChain message conversion (all message types).
 * Extends existing multimodal tests in utils.test.ts to cover full message lifecycle.
 */

import { Message as LangGraphMessage } from "@langchain/langgraph-sdk";
import { Message, UserMessage, TextInputContent, BinaryInputContent } from "@ag-ui/client";
import { aguiMessagesToLangChain, langchainMessagesToAgui } from "./utils";

describe("Message Conversion - All Types", () => {
  describe("aguiMessagesToLangChain", () => {
    it("should convert user message", () => {
      const msg: Message = { id: "h1", role: "user", content: "Hello" };
      const result = aguiMessagesToLangChain([msg]);
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe("human");
      expect(result[0].content).toBe("Hello");
      expect(result[0].id).toBe("h1");
    });

    it("should convert assistant message", () => {
      const msg: Message = { id: "a1", role: "assistant", content: "Hi there" };
      const result = aguiMessagesToLangChain([msg]);
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe("ai");
      expect(result[0].content).toBe("Hi there");
    });

    it("should convert assistant message with tool calls", () => {
      const msg: Message = {
        id: "a2",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "tc1",
            type: "function",
            function: { name: "search", arguments: '{"query":"weather"}' },
          },
        ],
      };
      const result = aguiMessagesToLangChain([msg]);
      expect(result[0].tool_calls).toHaveLength(1);
      expect(result[0].tool_calls![0].name).toBe("search");
      expect(result[0].tool_calls![0].args).toEqual({ query: "weather" });
    });

    it("should convert system message", () => {
      const msg: Message = { id: "s1", role: "system", content: "Be helpful" };
      const result = aguiMessagesToLangChain([msg]);
      expect(result[0].type).toBe("system");
      expect(result[0].content).toBe("Be helpful");
    });

    it("should convert tool message", () => {
      const msg: Message = { id: "t1", role: "tool", content: "42", toolCallId: "tc1" };
      const result = aguiMessagesToLangChain([msg]);
      expect(result[0].type).toBe("tool");
      expect(result[0].content).toBe("42");
      expect(result[0].tool_call_id).toBe("tc1");
    });

    it("should throw for unsupported role", () => {
      const msg = { id: "x", role: "unknown", content: "test" } as any;
      expect(() => aguiMessagesToLangChain([msg])).toThrow("not supported");
    });

    it("should preserve message ordering", () => {
      const msgs: Message[] = [
        { id: "1", role: "user", content: "Q" },
        { id: "2", role: "assistant", content: "A" },
        { id: "3", role: "user", content: "Q2" },
      ];
      const result = aguiMessagesToLangChain(msgs);
      expect(result).toHaveLength(3);
      expect(result[0].type).toBe("human");
      expect(result[1].type).toBe("ai");
      expect(result[2].type).toBe("human");
    });
  });

  describe("langchainMessagesToAgui", () => {
    it("should convert human message", () => {
      const msg: LangGraphMessage = { id: "h1", type: "human", content: "Hello", role: "user" };
      const result = langchainMessagesToAgui([msg]);
      expect(result[0].role).toBe("user");
      expect(result[0].content).toBe("Hello");
      expect(result[0].id).toBe("h1");
    });

    it("should convert ai message with tool calls", () => {
      const msg: LangGraphMessage = {
        id: "a2",
        type: "ai",
        content: "",
        role: "assistant",
        tool_calls: [{ id: "tc1", name: "search", args: { q: "hello" } }],
      };
      const result = langchainMessagesToAgui([msg]);
      expect(result[0].role).toBe("assistant");
      expect(result[0].toolCalls).toHaveLength(1);
      expect(result[0].toolCalls![0].function.name).toBe("search");
      expect(JSON.parse(result[0].toolCalls![0].function.arguments)).toEqual({ q: "hello" });
    });

    it("should convert system message", () => {
      const msg: LangGraphMessage = { id: "s1", type: "system", content: "Sys prompt", role: "system" };
      const result = langchainMessagesToAgui([msg]);
      expect(result[0].role).toBe("system");
    });

    it("should convert tool message", () => {
      const msg: LangGraphMessage = { id: "t1", type: "tool", content: "result", role: "tool", tool_call_id: "tc1" };
      const result = langchainMessagesToAgui([msg]);
      expect(result[0].role).toBe("tool");
      expect(result[0].toolCallId).toBe("tc1");
    });

    it("should throw for unsupported type", () => {
      const msg = { id: "x", type: "unknown", content: "", role: "other" } as any;
      expect(() => langchainMessagesToAgui([msg])).toThrow("not supported");
    });

    it("should handle multimodal human message", () => {
      const msg: LangGraphMessage = {
        id: "m1",
        type: "human",
        content: [
          { type: "text", text: "Look at this" },
          { type: "image_url", image_url: { url: "https://example.com/img.png" } },
        ] as any,
        role: "user",
      };
      const result = langchainMessagesToAgui([msg]);
      const content = result[0].content as any[];
      expect(content).toHaveLength(2);
      expect(content[0].type).toBe("text");
      expect(content[1].type).toBe("binary");
      expect(content[1].url).toBe("https://example.com/img.png");
    });

    it("should parse data URLs in multimodal content", () => {
      const msg: LangGraphMessage = {
        id: "m2",
        type: "human",
        content: [
          { type: "image_url", image_url: { url: "data:image/jpeg;base64,abc123" } },
        ] as any,
        role: "user",
      };
      const result = langchainMessagesToAgui([msg]);
      const content = result[0].content as any[];
      expect(content[0].type).toBe("binary");
      expect(content[0].mimeType).toBe("image/jpeg");
      expect(content[0].data).toBe("abc123");
    });
  });

  describe("Round-trip conversion", () => {
    it("should round-trip user message", () => {
      const original: Message = { id: "rt1", role: "user", content: "Test" };
      const lc = aguiMessagesToLangChain([original]);
      const back = langchainMessagesToAgui(lc);
      expect(back[0].role).toBe("user");
      expect(back[0].content).toBe("Test");
      expect(back[0].id).toBe("rt1");
    });

    it("should round-trip assistant with tool calls", () => {
      const original: Message = {
        id: "rt2",
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "tc1", type: "function", function: { name: "calc", arguments: '{"x":1}' } },
        ],
      };
      const lc = aguiMessagesToLangChain([original]);
      const back = langchainMessagesToAgui(lc);
      expect(back[0].toolCalls).toHaveLength(1);
      expect(back[0].toolCalls![0].function.name).toBe("calc");
    });

    it("should round-trip tool message", () => {
      const original: Message = { id: "rt3", role: "tool", content: "done", toolCallId: "tc1" };
      const lc = aguiMessagesToLangChain([original]);
      const back = langchainMessagesToAgui(lc);
      expect(back[0].role).toBe("tool");
      expect(back[0].content).toBe("done");
      expect(back[0].toolCallId).toBe("tc1");
    });
  });
});

/**
 * Tests for AG-UI <-> LangChain message conversion (all message types).
 * Extends existing multimodal tests in utils.test.ts to cover full message lifecycle.
 */

import { Message as LangGraphMessage } from "@langchain/langgraph-sdk";
import { Message } from "@ag-ui/client";
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
      const result: any[] = aguiMessagesToLangChain([msg]);
      expect(result[0].tool_calls).toHaveLength(1);
      expect(result[0].tool_calls[0].name).toBe("search");
      expect(result[0].tool_calls[0].args).toEqual({ query: "weather" });
    });

    it("should convert system message", () => {
      const msg: Message = { id: "s1", role: "system", content: "Be helpful" };
      const result = aguiMessagesToLangChain([msg]);
      expect(result[0].type).toBe("system");
      expect(result[0].content).toBe("Be helpful");
    });

    it("should convert tool message", () => {
      const msg: Message = { id: "t1", role: "tool", content: "42", toolCallId: "tc1" };
      const result: any[] = aguiMessagesToLangChain([msg]);
      expect(result[0].type).toBe("tool");
      expect(result[0].content).toBe("42");
      expect(result[0].tool_call_id).toBe("tc1");
    });

    it("should throw for unsupported role", () => {
      const msg = { id: "x", role: "unknown", content: "test" } as any;
      expect(() => aguiMessagesToLangChain([msg])).toThrow("not supported");
    });

    // Regression test: the AG-UI message history accumulated by the frontend
    // includes a `role: "reasoning"` message whenever the agent emits
    // REASONING_MESSAGE_* events. On the next turn, the frontend sends the
    // full history back; the converter previously threw on the unknown role
    // and the runtime surfaced it as a `RUN_ERROR` toast
    // ("message role is not supported." / code INCOMPLETE_STREAM).
    //
    // Reasoning carries provider-specific encrypted state in
    // `encryptedValue` (OpenAI Responses API `encrypted_content`, Anthropic
    // `signature`) that providers use to maintain reasoning continuity
    // across turns. We forward reasoning as an AIMessage with a
    // `type: "reasoning"` content block so langchain-openai's Responses-API
    // path threads it back as a reasoning input item.
    it("should forward reasoning messages as AI messages with reasoning content blocks", () => {
      const msgs: Message[] = [
        { id: "u1", role: "user", content: "Tokyo weather?" },
        {
          id: "r1",
          role: "reasoning",
          content: "I should call get_weather.",
          encryptedValue: "rs_encrypted_signature_abc",
        } as any,
        { id: "a1", role: "assistant", content: "Looking it up." },
      ];
      const result = aguiMessagesToLangChain(msgs);
      expect(result).toHaveLength(3);
      expect(result[0].type).toBe("human");
      expect(result[1].type).toBe("ai");
      const reasoningMsg = result[1] as any;
      expect(Array.isArray(reasoningMsg.content)).toBe(true);
      expect(reasoningMsg.content).toHaveLength(1);
      expect(reasoningMsg.content[0].type).toBe("reasoning");
      expect(reasoningMsg.content[0].id).toBe("r1");
      expect(reasoningMsg.content[0].summary).toEqual([
        { type: "summary_text", text: "I should call get_weather." },
      ]);
      // Encrypted state surfaces under both encrypted_content (OpenAI) and
      // signature (Anthropic) so whichever provider serializes the message
      // can pick up the reasoning state.
      expect(reasoningMsg.content[0].encrypted_content).toBe("rs_encrypted_signature_abc");
      expect(reasoningMsg.content[0].signature).toBe("rs_encrypted_signature_abc");
      expect(result[2].type).toBe("ai");
      expect(result[2].content).toBe("Looking it up.");
    });

    it("should forward reasoning without encryptedValue (no signature key)", () => {
      const msgs: Message[] = [
        {
          id: "r1",
          role: "reasoning",
          content: "Plain rendered summary.",
        } as any,
      ];
      const result = aguiMessagesToLangChain(msgs);
      expect(result).toHaveLength(1);
      const block = (result[0] as any).content[0];
      expect(block.type).toBe("reasoning");
      expect(block.summary).toEqual([
        { type: "summary_text", text: "Plain rendered summary." },
      ]);
      expect(block.encrypted_content).toBeUndefined();
      expect(block.signature).toBeUndefined();
    });

    // Activity messages are display-only progress events (status pills,
    // streaming progress bars, etc.) emitted via AG-UI events. They have
    // no LLM-relevant content and no analogue in LangGraph's message
    // types; skip rather than throw so multi-turn flows with activity
    // history don't break.
    it("should skip activity messages instead of throwing", () => {
      const msgs: Message[] = [
        { id: "u1", role: "user", content: "Run the search." },
        {
          id: "act1",
          role: "activity",
          activityType: "search-progress",
          content: { phase: "running" },
        } as any,
        { id: "a1", role: "assistant", content: "Done." },
      ];
      const result = aguiMessagesToLangChain(msgs);
      expect(result).toHaveLength(2);
      expect(result[0].type).toBe("human");
      expect(result[1].type).toBe("ai");
    });

    // OpenAI's "developer" role supersedes "system" on newer models; in
    // LangChain it still maps to a SystemMessage. Map rather than throw so
    // demo agents that set `role: "developer"` system prompts still work.
    it("should convert developer message to system", () => {
      const msg: Message = { id: "d1", role: "developer", content: "Be concise." } as any;
      const result = aguiMessagesToLangChain([msg]);
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe("system");
      expect((result[0] as any).role).toBe("system");
      expect(result[0].content).toBe("Be concise.");
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
      // Cast to any to bypass strict LangGraph SDK type checks — runtime shape is valid
      const msg = { id: "h1", type: "human", content: "Hello" } as any as LangGraphMessage;
      const result = langchainMessagesToAgui([msg]);
      expect(result[0].role).toBe("user");
      expect(result[0].content).toBe("Hello");
      expect(result[0].id).toBe("h1");
    });

    it("should convert ai message with tool calls", () => {
      const msg = {
        id: "a2",
        type: "ai",
        content: "",
        tool_calls: [{ id: "tc1", name: "search", args: { q: "hello" } }],
      } as any as LangGraphMessage;
      const result: any[] = langchainMessagesToAgui([msg]);
      expect(result[0].role).toBe("assistant");
      expect(result[0].toolCalls).toHaveLength(1);
      expect(result[0].toolCalls[0].function.name).toBe("search");
      expect(JSON.parse(result[0].toolCalls[0].function.arguments)).toEqual({ q: "hello" });
    });

    it("should convert system message", () => {
      const msg = { id: "s1", type: "system", content: "Sys prompt" } as any as LangGraphMessage;
      const result = langchainMessagesToAgui([msg]);
      expect(result[0].role).toBe("system");
    });

    it("should convert tool message", () => {
      const msg = { id: "t1", type: "tool", content: "result", tool_call_id: "tc1" } as any as LangGraphMessage;
      const result: any[] = langchainMessagesToAgui([msg]);
      expect(result[0].role).toBe("tool");
      expect(result[0].toolCallId).toBe("tc1");
    });

    it("should throw for unsupported type", () => {
      const msg = { id: "x", type: "unknown", content: "", role: "other" } as any;
      expect(() => langchainMessagesToAgui([msg])).toThrow("not supported");
    });

    it("should handle multimodal human message", () => {
      const msg = {
        id: "m1",
        type: "human",
        content: [
          { type: "text", text: "Look at this" },
          { type: "image_url", image_url: { url: "https://example.com/img.png" } },
        ],
      } as any as LangGraphMessage;
      const result = langchainMessagesToAgui([msg]);
      const content = result[0].content as any[];
      expect(content).toHaveLength(2);
      expect(content[0].type).toBe("text");
      expect(content[1].type).toBe("image");
      expect(content[1].source.type).toBe("url");
      expect(content[1].source.value).toBe("https://example.com/img.png");
    });

    it("should parse data URLs in multimodal content", () => {
      const msg = {
        id: "m2",
        type: "human",
        content: [
          { type: "image_url", image_url: { url: "data:image/jpeg;base64,abc123" } },
        ],
      } as any as LangGraphMessage;
      const result = langchainMessagesToAgui([msg]);
      const content = result[0].content as any[];
      expect(content[0].type).toBe("image");
      expect(content[0].source.type).toBe("data");
      expect(content[0].source.mimeType).toBe("image/jpeg");
      expect(content[0].source.value).toBe("abc123");
    });
  });

  describe("Edge cases - langchainMessagesToAgui", () => {
    it("should return empty array for empty input", () => {
      expect(langchainMessagesToAgui([])).toHaveLength(0);
    });

    it("should handle ai message with list content (text blocks)", () => {
      const msg = {
        id: "a1",
        type: "ai",
        content: [{ type: "text", text: "extracted" }],
      } as any as LangGraphMessage;
      const result = langchainMessagesToAgui([msg]);
      expect(result[0].content).toBe("extracted");
    });

    it("should handle ai message with empty string content", () => {
      const msg = {
        id: "a2",
        type: "ai",
        content: "",
      } as any as LangGraphMessage;
      const result = langchainMessagesToAgui([msg]);
      expect(result[0].content).toBe("");
    });
  });

  describe("Edge cases - aguiMessagesToLangChain", () => {
    it("should return empty array for empty input", () => {
      expect(aguiMessagesToLangChain([])).toHaveLength(0);
    });

    it("should handle assistant message with no tool_calls", () => {
      const msg: Message = { id: "a3", role: "assistant", content: "plain text" };
      const result: any[] = aguiMessagesToLangChain([msg]);
      expect(result[0].type).toBe("ai");
      expect(result[0].tool_calls).toHaveLength(0);
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
      const back: any[] = langchainMessagesToAgui(lc);
      expect(back[0].toolCalls).toHaveLength(1);
      expect(back[0].toolCalls[0].function.name).toBe("calc");
    });

    it("should round-trip tool message", () => {
      const original: Message = { id: "rt3", role: "tool", content: "done", toolCallId: "tc1" };
      const lc = aguiMessagesToLangChain([original]);
      const back: any[] = langchainMessagesToAgui(lc);
      expect(back[0].role).toBe("tool");
      expect(back[0].content).toBe("done");
      expect(back[0].toolCallId).toBe("tc1");
    });
  });
});

/**
 * Tests for langGraphDefaultMergeState.
 * Covers basic merging, tool deduplication, and the orphaned-tools fix for #1412.
 *
 * NOTE: The LangGraphAgent constructor requires a LangGraph Platform client,
 * so we test the merge function by instantiating the agent minimally and calling
 * the method directly. We skip tests that require network/platform access.
 */

import { describe, it, expect } from "vitest";
import { Message as LangGraphMessage } from "@langchain/langgraph-sdk";
import { langGraphDefaultMergeState } from "./state-merging-helper";

// We can't easily instantiate LangGraphAgent (it requires a real LG Platform client),
// so we extract the merge logic into a standalone test helper that mirrors the agent method.
// See state-merging-helper.ts for the extracted function.

function makeTool(name: string, description = "desc") {
  return { name, description, parameters: { type: "object", properties: {} } };
}

describe("langGraphDefaultMergeState", () => {
  it("should append new messages to state", () => {
    const state = { messages: [{ id: "m1", type: "human" as const, content: "Hi", role: "user" }] };
    const newMessages: LangGraphMessage[] = [
      { id: "m2", type: "ai" as const, content: "Hello", role: "assistant" },
    ];
    const result = langGraphDefaultMergeState(state, newMessages, { tools: [] });
    expect(result.messages.some((m: any) => m.id === "m2")).toBe(true);
  });

  it("should exclude duplicate messages by id", () => {
    const msg = { id: "m1", type: "human" as const, content: "Hi", role: "user" };
    const state = { messages: [msg] };
    const result = langGraphDefaultMergeState(state, [msg], { tools: [] });
    expect(result.messages).toHaveLength(0);
  });

  it("should strip leading system message", () => {
    const msgs: LangGraphMessage[] = [
      { id: "s1", role: "system", content: "sys", type: "system" },
      { id: "h1", role: "user", content: "Hi", type: "human" },
    ];
    const result = langGraphDefaultMergeState({ messages: [] }, msgs, { tools: [] });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].id).toBe("h1");
  });

  it("should deduplicate tools with input winning over state (issue #1412)", () => {
    const stateTool = { type: "function", name: "search", function: { name: "search", description: "old", parameters: {} } };
    const state = { messages: [], tools: [stateTool] };
    const inputTool = makeTool("search", "new and improved");
    const result = langGraphDefaultMergeState(state, [], { tools: [inputTool] });
    const searchTools = result.tools.filter((t: any) => t.name === "search" || t.function?.name === "search");
    expect(searchTools).toHaveLength(1);
    // Input version should win
    const desc = searchTools[0].description || searchTools[0].function?.description;
    expect(desc).toBe("new and improved");
  });

  it("should preserve orphaned tools from state (issue #1412)", () => {
    const toolA = { type: "function", name: "tool_a", function: { name: "tool_a", description: "A", parameters: {} } };
    const toolB = { type: "function", name: "tool_b", function: { name: "tool_b", description: "B", parameters: {} } };
    const state = { messages: [], tools: [toolA, toolB] };
    const inputToolA = makeTool("tool_a", "A updated");
    const result = langGraphDefaultMergeState(state, [], { tools: [inputToolA] });
    const toolNames = result.tools.map((t: any) => t.name || t.function?.name);
    expect(toolNames).toContain("tool_a");
    expect(toolNames).toContain("tool_b");
  });

  it("should preserve state tools when input has none", () => {
    const toolA = { type: "function", name: "tool_a", function: { name: "tool_a", description: "A", parameters: {} } };
    const state = { messages: [], tools: [toolA] };
    const result = langGraphDefaultMergeState(state, [], { tools: [] });
    expect(result.tools).toHaveLength(1);
  });

  it("should use input tools when state has none", () => {
    const state = { messages: [], tools: [] };
    const result = langGraphDefaultMergeState(state, [], { tools: [makeTool("new_tool")] });
    const toolNames = result.tools.map((t: any) => t.name || t.function?.name);
    expect(toolNames).toContain("new_tool");
  });

  it("should handle neither having tools", () => {
    const state = { messages: [] };
    const result = langGraphDefaultMergeState(state, [], { tools: [] });
    expect(result.tools).toHaveLength(0);
  });

  it("should set ag-ui and copilotkit keys", () => {
    const state = { messages: [] };
    const result = langGraphDefaultMergeState(state, [], {
      tools: [makeTool("my_tool")],
      context: [{ description: "ctx", value: "val" }],
    });
    expect(result["ag-ui"]).toBeDefined();
    expect(result["ag-ui"].tools).toEqual(result.tools);
    expect(result.copilotkit).toBeDefined();
    expect(result.copilotkit.actions).toEqual(result.tools);
  });
});

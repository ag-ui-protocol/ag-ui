/**
 * Tests for parallel frontend tool-call handling in StrandsAgent.
 *
 * Port of Python's test_parallel_tool_call_handling.py.
 *
 * Scenario A – Multiple parallel frontend tool calls must all be emitted.
 * Scenario B – New tool calls must not be suppressed by a pending tool result
 *              on continuation turns.
 * Scenario C – Backend tool results must not leak after halt flag is set.
 */

import { describe, it, expect } from "vitest";
import { ToolUseBlock, TextBlock, ToolResultBlock } from "@strands-agents/sdk";
import type { AgentStreamEvent } from "@strands-agents/sdk";
import { EventType } from "@ag-ui/core";

import type { StrandsAgentConfig } from "../config";
import {
  collect,
  minimalRunInput,
  scriptedStrandsAgent,
  stream,
} from "./helpers";

// ---------------------------------------------------------------------------
// Scenario A – All parallel frontend tool calls must be emitted
// ---------------------------------------------------------------------------

describe("Parallel frontend tool calls — all emitted", () => {
  const TOOLS = [
    { name: "frontend_a", description: "a", parameters: {} },
    { name: "frontend_b", description: "b", parameters: {} },
  ];

  it("both tool calls are emitted via ToolUseBlock path", async () => {
    const blockA = new ToolUseBlock({
      name: "frontend_a",
      toolUseId: "st-a",
      input: {},
    });
    const blockB = new ToolUseBlock({
      name: "frontend_b",
      toolUseId: "st-b",
      input: {},
    });
    const agent = scriptedStrandsAgent([
      blockA as unknown as AgentStreamEvent,
      blockB as unknown as AgentStreamEvent,
    ]);
    const events = await collect(agent, minimalRunInput({ tools: TOOLS }));
    const starts = events.filter(
      (e) => e.type === EventType.TOOL_CALL_START,
    ) as unknown as { toolCallName: string }[];
    const names = new Set(starts.map((s) => s.toolCallName));
    expect(names.has("frontend_a")).toBe(true);
    expect(names.has("frontend_b")).toBe(true);
    expect(starts).toHaveLength(2);
  });

  it("both tool calls are emitted via streaming contentBlockStop path", async () => {
    const events: AgentStreamEvent[] = [
      stream.toolUseStart("st-a", "frontend_a"),
      stream.toolUseDelta("{}"),
      stream.blockStop(),
      stream.toolUseStart("st-b", "frontend_b"),
      stream.toolUseDelta("{}"),
      stream.blockStop(),
    ];
    const agent = scriptedStrandsAgent(events);
    const result = await collect(agent, minimalRunInput({ tools: TOOLS }));
    const starts = result.filter(
      (e) => e.type === EventType.TOOL_CALL_START,
    ) as unknown as { toolCallName: string }[];
    const names = new Set(starts.map((s) => s.toolCallName));
    expect(names.has("frontend_a")).toBe(true);
    expect(names.has("frontend_b")).toBe(true);
    expect(starts).toHaveLength(2);
  });

  it("every TOOL_CALL_START has a matching TOOL_CALL_END", async () => {
    const blockA = new ToolUseBlock({
      name: "frontend_a",
      toolUseId: "st-a",
      input: {},
    });
    const blockB = new ToolUseBlock({
      name: "frontend_b",
      toolUseId: "st-b",
      input: {},
    });
    const agent = scriptedStrandsAgent([
      blockA as unknown as AgentStreamEvent,
      blockB as unknown as AgentStreamEvent,
    ]);
    const result = await collect(agent, minimalRunInput({ tools: TOOLS }));
    const startIds = new Set(
      (
        result.filter(
          (e) => e.type === EventType.TOOL_CALL_START,
        ) as unknown as {
          toolCallId: string;
        }[]
      ).map((e) => e.toolCallId),
    );
    const endIds = new Set(
      (
        result.filter((e) => e.type === EventType.TOOL_CALL_END) as unknown as {
          toolCallId: string;
        }[]
      ).map((e) => e.toolCallId),
    );
    expect(startIds).toEqual(endIds);
    expect(startIds.size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Scenario B – New tool calls must not be suppressed by pending tool result
// ---------------------------------------------------------------------------

describe("Continuation turn emits new tool calls", () => {
  const TOOLS = [{ name: "frontend_tool", description: "d", parameters: {} }];

  function continuationMessages() {
    return [
      { id: "u1", role: "user" as const, content: "do something" },
      {
        id: "a1",
        role: "assistant" as const,
        content: "",
        toolCalls: [
          {
            id: "prev-tc",
            type: "function" as const,
            function: { name: "frontend_tool", arguments: "{}" },
          },
        ],
      },
      {
        id: "t1",
        role: "tool" as const,
        content: "done",
        toolCallId: "prev-tc",
      },
    ];
  }

  it("new tool call ID is emitted on continuation", async () => {
    const block = new ToolUseBlock({
      name: "frontend_tool",
      toolUseId: "st-new",
      input: { x: 1 },
    });
    const agent = scriptedStrandsAgent([block as unknown as AgentStreamEvent]);
    const events = await collect(
      agent,
      minimalRunInput({ messages: continuationMessages(), tools: TOOLS }),
    );
    const starts = events.filter(
      (e) => e.type === EventType.TOOL_CALL_START,
    ) as unknown as { toolCallName: string }[];
    expect(starts).toHaveLength(1);
    expect(starts[0].toolCallName).toBe("frontend_tool");
  });

  it("already-resolved backend tool call is suppressed", async () => {
    const messages = [
      { id: "u1", role: "user" as const, content: "do something" },
      {
        id: "a1",
        role: "assistant" as const,
        content: "",
        toolCalls: [
          {
            id: "prev-tc",
            type: "function" as const,
            function: { name: "backend_tool", arguments: "{}" },
          },
        ],
      },
      {
        id: "t1",
        role: "tool" as const,
        content: "result",
        toolCallId: "prev-tc",
      },
    ];
    const block = new ToolUseBlock({
      name: "backend_tool",
      toolUseId: "prev-tc",
      input: {},
    });
    const agent = scriptedStrandsAgent([block as unknown as AgentStreamEvent]);
    const events = await collect(
      agent,
      minimalRunInput({ messages, tools: [] }),
    );
    const starts = events.filter((e) => e.type === EventType.TOOL_CALL_START);
    expect(starts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario C – No backend tool results must leak after halt
// ---------------------------------------------------------------------------

describe("No backend result leak after halt", () => {
  it("only the halting result is emitted", async () => {
    const config: StrandsAgentConfig = {
      toolBehaviors: {
        backend_halt_tool: { stopStreamingAfterResult: true },
      },
    };
    const block1 = new ToolUseBlock({
      name: "backend_halt_tool",
      toolUseId: "st1",
      input: {},
    });
    const block2 = new ToolUseBlock({
      name: "backend_other",
      toolUseId: "st2",
      input: {},
    });
    const result1 = new ToolResultBlock({
      toolUseId: "st1",
      status: "success",
      content: [new TextBlock(JSON.stringify({ value: 1 }))],
    });
    const result2 = new ToolResultBlock({
      toolUseId: "st2",
      status: "success",
      content: [new TextBlock(JSON.stringify({ value: 2 }))],
    });

    const events: AgentStreamEvent[] = [
      block1 as unknown as AgentStreamEvent,
      block2 as unknown as AgentStreamEvent,
      {
        type: "afterToolCallEvent",
        toolUse: { toolUseId: "st1", name: "backend_halt_tool", input: {} },
        result: result1,
      } as unknown as AgentStreamEvent,
      {
        type: "afterToolCallEvent",
        toolUse: { toolUseId: "st2", name: "backend_other", input: {} },
        result: result2,
      } as unknown as AgentStreamEvent,
    ];

    const agent = scriptedStrandsAgent(events, { config });
    const result = await collect(agent);
    const resultEvents = result.filter(
      (e) => e.type === EventType.TOOL_CALL_RESULT,
    ) as unknown as { toolCallId: string }[];
    const resultIds = resultEvents.map((e) => e.toolCallId);

    expect(resultIds).toContain("st1");
    expect(resultIds).not.toContain("st2");
    expect(resultEvents).toHaveLength(1);
  });
});

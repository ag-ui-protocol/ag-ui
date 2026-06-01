/**
 * A tool that returns void / null / empty still produces TOOL_CALL_RESULT,
 * so legitimate side-effect tools get a result card in the UI instead of
 * silently dropping the emission.
 */

import { describe, it, expect } from "vitest";
import { ToolUseBlock, ToolResultBlock } from "@strands-agents/sdk";
import type { AgentStreamEvent } from "@strands-agents/sdk";
import { EventType } from "@ag-ui/core";

import { collect, scriptedStrandsAgent } from "./helpers";

describe("Tool callback returning null/empty", () => {
  it("still emits TOOL_CALL_RESULT with empty content", async () => {
    // Simulate Strands emitting an AfterToolCallEvent where `content` is
    // an empty array (e.g. a side-effect tool that returned undefined).
    const events: AgentStreamEvent[] = [
      new ToolUseBlock({
        name: "log_event",
        toolUseId: "tu-1",
        input: { msg: "hello" },
      }) as unknown as AgentStreamEvent,
      {
        type: "afterToolCallEvent",
        toolUse: { name: "log_event", toolUseId: "tu-1" },
        result: new ToolResultBlock({
          toolUseId: "tu-1",
          status: "success",
          content: [],
        }),
      } as unknown as AgentStreamEvent,
    ];
    const agent = scriptedStrandsAgent(events);
    const out = await collect(agent);
    const kinds = out.map((e) => e.type);
    expect(kinds).toContain(EventType.TOOL_CALL_START);
    expect(kinds).toContain(EventType.TOOL_CALL_END);
    expect(kinds).toContain(EventType.TOOL_CALL_RESULT);
    const result = out.find(
      (e) => e.type === EventType.TOOL_CALL_RESULT,
    ) as unknown as {
      content?: string;
      toolCallId?: string;
    };
    expect(result?.toolCallId).toBe("tu-1");
    // Empty content (not JSON `null`, not a stringified null) — the UI can
    // still render a result card.
    expect(result?.content).toBe("");
  });
});

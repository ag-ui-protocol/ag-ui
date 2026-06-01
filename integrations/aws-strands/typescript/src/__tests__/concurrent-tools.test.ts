/**
 * Concurrent tool executor — event ordering integrity.
 *
 * Strands defaults to `toolExecutor: 'concurrent'` which executes multiple
 * tool calls from one model turn in parallel. The AG-UI adapter must keep
 * per-toolCallId envelope integrity: for each id X, TOOL_CALL_START{X}
 * must precede ARGS{X} which must precede END{X} which must precede
 * RESULT{X}. Interleaving across ids is allowed — but never within an id.
 *
 * We drive a stub Strands stream that interleaves two tools' events and
 * verify the adapter's output preserves per-id ordering.
 */

import { describe, it, expect } from "vitest";
import { ToolUseBlock, TextBlock, ToolResultBlock } from "@strands-agents/sdk";
import type { AgentStreamEvent } from "@strands-agents/sdk";
import { EventType, type BaseEvent } from "@ag-ui/core";

import { collect, scriptedStrandsAgent } from "./helpers";

/**
 * Returns, for each toolCallId, the ordered indices of its START/ARGS/END
 * /RESULT events in the output stream. Used to assert per-id envelope
 * integrity even when events interleave across tools.
 */
function groupByToolCallId(events: BaseEvent[]) {
  const idx: Record<string, Array<{ type: string; i: number }>> = {};
  events.forEach((e, i) => {
    const id = (e as unknown as { toolCallId?: string }).toolCallId;
    if (!id) return;
    (idx[id] ??= []).push({ type: e.type, i });
  });
  return idx;
}

describe("Concurrent tool executor envelope integrity (proof 4)", () => {
  it("interleaved two-tool stream preserves per-id START → ARGS → END → RESULT ordering", async () => {
    // Interleave two tool calls' events in a pattern a concurrent executor
    // might actually produce. Strands yields ToolUseBlocks as each one
    // finishes streaming from the model, then executes them in parallel
    // and yields AfterToolCallEvents in whatever order completes.
    const events: AgentStreamEvent[] = [
      // Tool A completes (ToolUseBlock emitted)
      new ToolUseBlock({
        name: "Multiply",
        toolUseId: "strands-A",
        input: { a: 2, b: 3 },
      }) as unknown as AgentStreamEvent,
      // Tool B completes (ToolUseBlock emitted)
      new ToolUseBlock({
        name: "Multiply",
        toolUseId: "strands-B",
        input: { a: 5, b: 7 },
      }) as unknown as AgentStreamEvent,
      // Concurrent execution finishes in B-first order
      {
        type: "afterToolCallEvent",
        toolUse: {
          toolUseId: "strands-B",
          name: "Multiply",
          input: { a: 5, b: 7 },
        },
        tool: undefined,
        result: new ToolResultBlock({
          toolUseId: "strands-B",
          status: "success",
          content: [new TextBlock("35")],
        }),
      } as unknown as AgentStreamEvent,
      {
        type: "afterToolCallEvent",
        toolUse: {
          toolUseId: "strands-A",
          name: "Multiply",
          input: { a: 2, b: 3 },
        },
        tool: undefined,
        result: new ToolResultBlock({
          toolUseId: "strands-A",
          status: "success",
          content: [new TextBlock("6")],
        }),
      } as unknown as AgentStreamEvent,
    ];
    const out = await collect(scriptedStrandsAgent(events));

    // Both tools must produce START/ARGS/END/RESULT.
    const grouped = groupByToolCallId(out);
    expect(Object.keys(grouped).sort()).toEqual(["strands-A", "strands-B"]);
    for (const id of Object.keys(grouped)) {
      const kinds = grouped[id]!.map((x) => x.type);
      const startIdx = kinds.indexOf(EventType.TOOL_CALL_START);
      const argsIdx = kinds.indexOf(EventType.TOOL_CALL_ARGS);
      const endIdx = kinds.indexOf(EventType.TOOL_CALL_END);
      const resultIdx = kinds.indexOf(EventType.TOOL_CALL_RESULT);
      expect(startIdx, `${id} has TOOL_CALL_START`).toBeGreaterThanOrEqual(0);
      expect(argsIdx, `${id} has TOOL_CALL_ARGS`).toBeGreaterThan(startIdx);
      expect(endIdx, `${id} has TOOL_CALL_END`).toBeGreaterThan(argsIdx);
      expect(resultIdx, `${id} has TOOL_CALL_RESULT`).toBeGreaterThan(endIdx);
    }

    // Verify result values match inputs (no cross-contamination).
    const resA = out.find(
      (e) =>
        e.type === EventType.TOOL_CALL_RESULT &&
        (e as unknown as { toolCallId: string }).toolCallId === "strands-A",
    ) as unknown as { content: string };
    const resB = out.find(
      (e) =>
        e.type === EventType.TOOL_CALL_RESULT &&
        (e as unknown as { toolCallId: string }).toolCallId === "strands-B",
    ) as unknown as { content: string };
    expect(Number(JSON.parse(resA.content))).toBe(6);
    expect(Number(JSON.parse(resB.content))).toBe(35);
  });

  it("three-way interleave — each id's envelope is self-contained", async () => {
    const make = (id: string, a: number, b: number) =>
      new ToolUseBlock({
        name: "Multiply",
        toolUseId: id,
        input: { a, b },
      }) as unknown as AgentStreamEvent;
    const result = (id: string, v: number) =>
      ({
        type: "afterToolCallEvent",
        toolUse: { toolUseId: id, name: "Multiply", input: {} },
        tool: undefined,
        result: new ToolResultBlock({
          toolUseId: id,
          status: "success",
          content: [new TextBlock(String(v))],
        }),
      }) as unknown as AgentStreamEvent;

    const events: AgentStreamEvent[] = [
      make("t1", 2, 3),
      make("t2", 5, 7),
      make("t3", 11, 13),
      // Finishes in scrambled order
      result("t3", 143),
      result("t1", 6),
      result("t2", 35),
    ];
    const out = await collect(scriptedStrandsAgent(events));
    const grouped = groupByToolCallId(out);
    expect(Object.keys(grouped).sort()).toEqual(["t1", "t2", "t3"]);

    const resultByTid: Record<string, number> = {};
    for (const e of out) {
      if (e.type === EventType.TOOL_CALL_RESULT) {
        resultByTid[(e as unknown as { toolCallId: string }).toolCallId] =
          Number(JSON.parse((e as unknown as { content: string }).content));
      }
    }
    expect(resultByTid).toEqual({ t1: 6, t2: 35, t3: 143 });
  });
});

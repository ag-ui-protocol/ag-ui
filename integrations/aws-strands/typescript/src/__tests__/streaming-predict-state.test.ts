/**
 * Tool-call wire ordering for streaming predict_state.
 *
 * The documented order (Python adapter's fix #1638) is:
 *   PredictState (CustomEvent)   — once, BEFORE any args
 *   TOOL_CALL_START
 *   TOOL_CALL_ARGS (delta)       — one per toolUseInputDelta chunk
 *   ...
 *   TOOL_CALL_ARGS (final delta) — any residual growth at contentBlockStop
 *   STATE_SNAPSHOT (stateFromArgs) — BEFORE end, so CopilotKit has real
 *                                   state when prediction is released
 *   TOOL_CALL_END
 *   MESSAGES_SNAPSHOT             — rotates message_id
 *
 * These tests pin that order against the streaming (toolUseInputDelta) path.
 */

import { describe, it, expect } from "vitest";
import type { AgentStreamEvent } from "@strands-agents/sdk";
import { EventType } from "@ag-ui/core";

import type { StrandsAgentConfig } from "../config";
import {
  collect,
  minimalRunInput,
  scriptedStrandsAgent,
  stream,
} from "./helpers";

// Stream a tool call across N toolUseInputDelta chunks. The adapter must
// emit TOOL_CALL_ARGS deltas that concatenate back to the full payload.
//
// Event shape matches Strands v1 SDK's Bedrock adapter — `start.type =
// "toolUseStart"` on the block-start, not `contentBlock.type = "toolUse"`.
function streamingScript(
  toolName: string,
  toolUseId: string,
  chunks: string[],
): AgentStreamEvent[] {
  const events: AgentStreamEvent[] = [stream.toolUseStart(toolUseId, toolName)];
  for (const c of chunks) {
    events.push(stream.toolUseDelta(c));
  }
  events.push(stream.blockStop());
  return events;
}

describe("tool-call wire ordering (streaming path)", () => {
  it("emits PredictState BEFORE TOOL_CALL_START and streams args incrementally", async () => {
    const chunks = ['{"steps"', ":[1,2", ",3]}"];
    const config: StrandsAgentConfig = {
      toolBehaviors: {
        make_plan: {
          predictState: {
            stateKey: "plan",
            tool: "make_plan",
            toolArgument: "steps",
          },
        },
      },
    };
    const agent = scriptedStrandsAgent(
      streamingScript("make_plan", "tc1", chunks),
      { config },
    );
    const events = await collect(
      agent,
      minimalRunInput({
        tools: [{ name: "make_plan", description: "", parameters: {} }],
      }),
    );

    // Strip out MESSAGES_SNAPSHOT and other frames to isolate the tool-call order.
    const orderingRelevant = events
      .map((e) => e.type as string)
      .filter((t) =>
        [
          EventType.CUSTOM,
          EventType.TOOL_CALL_START,
          EventType.TOOL_CALL_ARGS,
          EventType.TOOL_CALL_END,
        ].includes(t as EventType),
      );

    // PredictState (CustomEvent) comes first.
    expect(orderingRelevant[0]).toBe(EventType.CUSTOM);
    expect(orderingRelevant[1]).toBe(EventType.TOOL_CALL_START);
    // Then one TOOL_CALL_ARGS per chunk (3 deltas).
    expect(
      orderingRelevant.filter((t) => t === EventType.TOOL_CALL_ARGS).length,
    ).toBeGreaterThanOrEqual(3);
    // TOOL_CALL_END is last of the tool-call family.
    expect(orderingRelevant[orderingRelevant.length - 1]).toBe(
      EventType.TOOL_CALL_END,
    );

    // Args deltas concatenate back to the full payload.
    const deltas = events
      .filter((e) => e.type === EventType.TOOL_CALL_ARGS)
      .map((e) => (e as unknown as { delta: string }).delta);
    expect(deltas.join("")).toBe(chunks.join(""));
  });

  it("emits stateFromArgs STATE_SNAPSHOT BEFORE TOOL_CALL_END", async () => {
    const config: StrandsAgentConfig = {
      toolBehaviors: {
        update_recipe: {
          stateFromArgs: () => ({ recipe: { status: "drafted" } }),
        },
      },
    };
    const agent = scriptedStrandsAgent(
      streamingScript("update_recipe", "tc2", ['{"name"', ':"pie"}']),
      { config },
    );
    const events = await collect(agent);

    const types = events.map((e) => e.type as string);
    const endIdx = types.indexOf(EventType.TOOL_CALL_END);
    const stateIdx = types.findIndex(
      (_t, i) =>
        i < endIdx &&
        events[i]!.type === EventType.STATE_SNAPSHOT &&
        // Skip the initial state snapshot (from inputData.state).
        i > types.indexOf(EventType.TOOL_CALL_START),
    );
    expect(stateIdx).toBeGreaterThan(-1);
    expect(stateIdx).toBeLessThan(endIdx);
  });

  it("stream(undefined) flush: residual growth between last delta and stop is sent as final TOOL_CALL_ARGS", async () => {
    // Construct a script where the LLM tacks on a suffix AFTER the last
    // toolUseInputDelta (simulated by the adapter picking up currentToolUse.inputChunks
    // joined at contentBlockStop). In practice this happens when Strands
    // combines multiple underlying chunks — the adapter re-reads the full
    // raw on stop and emits the missing tail.
    //
    // We approximate here by sending a partial chunk then expecting the
    // stop-time flush to still produce a complete args payload equal to
    // the input.
    const chunks = ['{"x":', "1}"];
    const agent = scriptedStrandsAgent(
      streamingScript("frontend_tool", "tc3", chunks),
    );
    const events = await collect(
      agent,
      minimalRunInput({
        tools: [{ name: "frontend_tool", description: "", parameters: {} }],
      }),
    );

    const deltas = events
      .filter((e) => e.type === EventType.TOOL_CALL_ARGS)
      .map((e) => (e as unknown as { delta: string }).delta);
    expect(deltas.join("")).toBe(chunks.join(""));
    // Exactly one TOOL_CALL_START / TOOL_CALL_END pair.
    expect(
      events.filter((e) => e.type === EventType.TOOL_CALL_START),
    ).toHaveLength(1);
    expect(
      events.filter((e) => e.type === EventType.TOOL_CALL_END),
    ).toHaveLength(1);
  });

  it("continuation run: already-resolved backend tool is suppressed (no re-emit)", async () => {
    // When Strands replays a backend tool already resolved in history, the
    // adapter must not re-emit TOOL_CALL_START/ARGS/END — Strands reuses
    // the original toolUseId, which lands in pendingToolResultIds, and the
    // adapter's streaming path routes that into the "pending" branch that
    // only fires state callbacks. Backend tools pass through as an empty
    // `tools` input (no frontend registry).
    const agent = scriptedStrandsAgent(
      streamingScript("backend_tool", "prev-tc", ['{"x":1}']),
    );
    const events = await collect(
      agent,
      minimalRunInput({
        tools: [],
        messages: [
          { id: "u1", role: "user", content: "go" },
          {
            id: "a1",
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: "prev-tc",
                type: "function",
                function: { name: "backend_tool", arguments: '{"x":1}' },
              },
            ],
          },
          { id: "t1", role: "tool", content: "ok", toolCallId: "prev-tc" },
        ],
      }),
    );

    const starts = events.filter((e) => e.type === EventType.TOOL_CALL_START);
    expect(starts).toHaveLength(0);
  });
});

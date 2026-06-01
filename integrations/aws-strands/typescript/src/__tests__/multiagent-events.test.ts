/**
 * Multi-agent events from the TS Strands SDK must translate to
 * AG-UI STEP_STARTED / STEP_FINISHED / CUSTOM{MultiAgentHandoff}.
 *
 * The TS SDK emits hook-event class instances — see
 * `@strands-agents/sdk/dist/src/multiagent/events.d.ts`:
 *   class BeforeNodeCallEvent   { type: 'beforeNodeCallEvent';   nodeId }
 *   class AfterNodeCallEvent    { type: 'afterNodeCallEvent';    nodeId, nodeType }
 *   class MultiAgentHandoffEvent{ type: 'multiAgentHandoffEvent'; source, targets }
 *
 * The Py adapter emits MultiAgentHandoff CustomEvents with
 * { from_nodes: [...], to_nodes: [...] }. TS converts `source` to a single-
 * element `from_nodes` array to preserve that wire shape for clients that
 * already consume Py events.
 */

import { describe, it, expect } from "vitest";
import { EventType } from "@ag-ui/core";
import type { AgentStreamEvent } from "@strands-agents/sdk";

import { collect, scriptedStrandsAgent, stream } from "./helpers";

describe("Multi-agent event dispatch", () => {
  it("beforeNodeCallEvent → STEP_STARTED uses nodeType prefix", async () => {
    const agent = scriptedStrandsAgent([
      stream.beforeNode("researcher", "multiAgent"),
    ]);
    const events = await collect(agent);
    const starts = events.filter(
      (e) => e.type === EventType.STEP_STARTED,
    ) as unknown as Array<{ stepName: string }>;
    expect(starts).toHaveLength(1);
    expect(starts[0].stepName).toBe("multiAgent:researcher");
  });

  it("beforeNodeCallEvent without nodeType falls back to 'agent:' prefix", async () => {
    const agent = scriptedStrandsAgent([
      {
        type: "beforeNodeCallEvent",
        nodeId: "researcher",
      } as unknown as AgentStreamEvent,
    ]);
    const events = await collect(agent);
    const starts = events.filter(
      (e) => e.type === EventType.STEP_STARTED,
    ) as unknown as Array<{ stepName: string }>;
    expect(starts).toHaveLength(1);
    expect(starts[0].stepName).toBe("agent:researcher");
  });

  // Spec (events.mdx §StepFinished): "The stepName must match the corresponding
  // StepStarted event to properly pair the beginning and end of the step."
  // Both START and FINISH must derive their prefix from the same `nodeType`
  // source so the pair stays matchable regardless of nodeType value.
  it("STEP_STARTED and STEP_FINISHED stepNames match when nodeType is set", async () => {
    const agent = scriptedStrandsAgent([
      stream.beforeNode("writer", "multiAgent"),
      stream.afterNode("writer", "multiAgent"),
    ]);
    const events = await collect(agent);
    const starts = events.filter(
      (e) => e.type === EventType.STEP_STARTED,
    ) as unknown as Array<{ stepName: string }>;
    const stops = events.filter(
      (e) => e.type === EventType.STEP_FINISHED,
    ) as unknown as Array<{ stepName: string }>;
    expect(starts).toHaveLength(1);
    expect(stops).toHaveLength(1);
    expect(starts[0].stepName).toBe(stops[0].stepName);
  });

  it("afterNodeCallEvent → STEP_FINISHED with nodeType prefix", async () => {
    const agent = scriptedStrandsAgent([
      stream.afterNode("writer", "multiAgent"),
    ]);
    const events = await collect(agent);
    const stops = events.filter(
      (e) => e.type === EventType.STEP_FINISHED,
    ) as unknown as Array<{ stepName: string }>;
    expect(stops).toHaveLength(1);
    expect(stops[0].stepName).toBe("multiAgent:writer");
  });

  it("multiAgentHandoffEvent → CUSTOM{MultiAgentHandoff} with Py-compatible from_nodes/to_nodes", async () => {
    const agent = scriptedStrandsAgent([
      stream.handoff("researcher", ["writer", "editor"]),
    ]);
    const events = await collect(agent);
    const customs = events.filter(
      (e) => e.type === EventType.CUSTOM,
    ) as unknown as Array<{
      name: string;
      value: Record<string, unknown>;
    }>;
    expect(customs).toHaveLength(1);
    expect(customs[0].name).toBe("MultiAgentHandoff");
    expect(customs[0].value).toMatchObject({
      from_nodes: ["researcher"],
      to_nodes: ["writer", "editor"],
    });
  });

  // The Py adapter forwards `message` inside the CustomEvent.value so a frontend
  // consuming either adapter can show the handoff caption.
  it("multiAgentHandoffEvent forwards the message field (Py parity)", async () => {
    const agent = scriptedStrandsAgent([
      stream.handoff("researcher", ["writer"], "Handing off draft to writer"),
    ]);
    const events = await collect(agent);
    const customs = events.filter(
      (e) => e.type === EventType.CUSTOM,
    ) as unknown as Array<{ value: Record<string, unknown> }>;
    expect(customs).toHaveLength(1);
    expect(customs[0].value.message).toBe("Handing off draft to writer");
  });

  it("full multi-node sequence produces paired STEP events and a handoff", async () => {
    const agent = scriptedStrandsAgent([
      {
        type: "beforeNodeCallEvent",
        nodeId: "n1",
      } as unknown as AgentStreamEvent,
      stream.afterNode("n1", "agent"),
      stream.handoff("n1", ["n2"]),
      {
        type: "beforeNodeCallEvent",
        nodeId: "n2",
      } as unknown as AgentStreamEvent,
      stream.afterNode("n2", "agent"),
    ]);
    const events = await collect(agent);
    const starts = events.filter((e) => e.type === EventType.STEP_STARTED);
    const stops = events.filter((e) => e.type === EventType.STEP_FINISHED);
    const customs = events.filter((e) => e.type === EventType.CUSTOM);
    expect(starts).toHaveLength(2);
    expect(stops).toHaveLength(2);
    expect(customs).toHaveLength(1);
  });

  it("legacy snake_case multiagent_* event names are ignored (TS SDK uses different names)", async () => {
    const agent = scriptedStrandsAgent([
      // Neither Py nor TS SDKs yield events in this snake_case shape at
      // the TS SDK boundary. The adapter must not match them and must
      // let them pass through without crashing.
      {
        type: "multiagent_node_start",
        node_id: "x",
        node_type: "agent",
      } as unknown as AgentStreamEvent,
      {
        type: "multiagent_handoff",
        from_node_ids: ["a"],
        to_node_ids: ["b"],
      } as unknown as AgentStreamEvent,
    ]);
    const events = await collect(agent);
    // No STEP or MultiAgentHandoff emitted for legacy snake_case.
    expect(events.some((e) => e.type === EventType.STEP_STARTED)).toBe(false);
    expect(
      events.some(
        (e) =>
          e.type === EventType.CUSTOM &&
          (e as unknown as { name?: string }).name === "MultiAgentHandoff",
      ),
    ).toBe(false);
  });
});

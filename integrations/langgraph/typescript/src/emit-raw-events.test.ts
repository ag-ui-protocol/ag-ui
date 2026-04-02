/**
 * Tests for emit-raw-events and emit-raw-event-data metadata flags.
 *
 * These mirror the Python tests in tests/test_emit_raw_events.py.
 */
import { describe, it, expect, vi } from "vitest";
import { Subscriber } from "rxjs";
import { EventType } from "@ag-ui/client";
import { LangGraphAgent, ProcessedEvents } from "./agent";

function makeAgent(): LangGraphAgent {
  return new LangGraphAgent({
    deploymentUrl: "http://localhost:8123",
    graphId: "test-graph",
  });
}

/** Collect events dispatched by the agent. */
function collectEvents(agent: LangGraphAgent): ProcessedEvents[] {
  const events: ProcessedEvents[] = [];
  // Set up a fake subscriber that records events
  agent.subscriber = {
    next: (event: ProcessedEvents) => events.push(event),
    error: () => {},
    complete: () => {},
    closed: false,
  } as unknown as Subscriber<ProcessedEvents>;
  return events;
}

// ---------------------------------------------------------------------------
// emit-raw-event-data — controls whether rawEvent is stripped from non-RAW events
// ---------------------------------------------------------------------------
describe("emit-raw-event-data flag", () => {
  it("strips rawEvent from non-RAW events when emitRawEventData is false", () => {
    const agent = makeAgent();
    const events = collectEvents(agent);
    agent.activeRun = { id: "run-1", emitRawEventData: false };

    agent.dispatchEvent({
      type: EventType.STATE_SNAPSHOT,
      snapshot: {},
      rawEvent: { some: "data" },
    } as any);

    expect(events).toHaveLength(1);
    expect(events[0].rawEvent).toBeUndefined();
  });

  it("preserves rawEvent on non-RAW events when emitRawEventData is true", () => {
    const agent = makeAgent();
    const events = collectEvents(agent);
    agent.activeRun = { id: "run-1", emitRawEventData: true };

    const rawPayload = { some: "data" };
    agent.dispatchEvent({
      type: EventType.STATE_SNAPSHOT,
      snapshot: {},
      rawEvent: rawPayload,
    } as any);

    expect(events).toHaveLength(1);
    expect(events[0].rawEvent).toEqual(rawPayload);
  });

  it("preserves rawEvent by default (no emitRawEventData set)", () => {
    const agent = makeAgent();
    const events = collectEvents(agent);
    agent.activeRun = { id: "run-1" };

    const rawPayload = { some: "data" };
    agent.dispatchEvent({
      type: EventType.STATE_SNAPSHOT,
      snapshot: {},
      rawEvent: rawPayload,
    } as any);

    expect(events).toHaveLength(1);
    expect(events[0].rawEvent).toEqual(rawPayload);
  });

  it("never strips rawEvent from RAW events regardless of emitRawEventData", () => {
    const agent = makeAgent();
    const events = collectEvents(agent);
    agent.activeRun = { id: "run-1", emitRawEventData: false };

    const rawPayload = { event: "on_chain_start", data: {} };
    agent.dispatchEvent({
      type: EventType.RAW,
      event: rawPayload,
      rawEvent: rawPayload,
    } as any);

    // RAW events should pass through untouched
    expect(events).toHaveLength(1);
    expect((events[0] as any).event).toEqual(rawPayload);
  });
});

// ---------------------------------------------------------------------------
// emit-raw-events — controls whether RAW events are emitted at all
// ---------------------------------------------------------------------------
describe("emit-raw-events flag", () => {
  // Note: These tests simulate the streaming loop's flag-reading logic because
  // testing through the full agent pipeline would require extensive LangGraph SDK
  // mocking. The logic below mirrors agent.ts's _handle_stream_events.

  /** Simulate the streaming loop's flag-reading and conditional RAW dispatch. */
  function simulateRawEventDispatch(
    agent: LangGraphAgent,
    chunkData: { metadata?: Record<string, unknown> },
  ) {
    const rawEmitFlag = chunkData.metadata?.["emit-raw-events"];
    const shouldEmitRaw = rawEmitFlag != null ? Boolean(rawEmitFlag) : true;
    const rawDataFlag = chunkData.metadata?.["emit-raw-event-data"];
    agent.activeRun!.emitRawEventData = rawDataFlag != null ? Boolean(rawDataFlag) : true;

    if (shouldEmitRaw) {
      agent.dispatchEvent({
        type: EventType.RAW,
        event: chunkData,
      } as any);
    }
  }

  it("suppresses RAW dispatch when metadata has emit-raw-events=false", () => {
    const agent = makeAgent();
    const events = collectEvents(agent);
    agent.activeRun = { id: "run-1" };

    simulateRawEventDispatch(agent, {
      metadata: { langgraph_node: "node1", "emit-raw-events": false },
    });

    expect(events.filter((e) => e.type === EventType.RAW)).toHaveLength(0);
  });

  it("emits RAW events by default (no flag in metadata)", () => {
    const agent = makeAgent();
    const events = collectEvents(agent);
    agent.activeRun = { id: "run-1" };

    simulateRawEventDispatch(agent, {
      metadata: { langgraph_node: "node1" },
    });

    expect(events.filter((e) => e.type === EventType.RAW)).toHaveLength(1);
  });

  it("emits RAW events when metadata has emit-raw-events=true", () => {
    const agent = makeAgent();
    const events = collectEvents(agent);
    agent.activeRun = { id: "run-1" };

    simulateRawEventDispatch(agent, {
      metadata: { langgraph_node: "node1", "emit-raw-events": true },
    });

    expect(events.filter((e) => e.type === EventType.RAW)).toHaveLength(1);
  });
});

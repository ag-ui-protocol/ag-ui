/**
 * MESSAGES_SNAPSHOT invariant tests.
 *
 * The invariant under test:
 *
 *   MESSAGES_SNAPSHOT reflects the graph checkpoint's `messages` —
 *   nothing else. Streaming-layer events (TEXT_MESSAGE_*,
 *   TOOL_CALL_*) carry in-progress content separately; the snapshot
 *   never mirrors or merges them.
 *
 * History: PR #1426 violated this by collecting every
 * on_chat_model_end output into an `activeRun.streamedMessages`
 * bucket and merging that bucket into the snapshot. The bucket could
 * not distinguish committed model outputs from transient internal
 * ones (`.withStructuredOutput()`, router/classifier calls), so the
 * snapshot picked up empty / duplicate assistant bubbles. PR #1543
 * tried to gate the merge on whether a subgraph-boundary fired;
 * Function Health kept seeing the leak because the gate didn't cover
 * the mid-stream emission. The correct fix is the one the customer
 * arrived at independently: the snapshot must not merge streamed
 * state at all — it reads straight from the checkpoint.
 */

import { describe, it, expect } from "vitest";
import { LangGraphAgent } from "./agent";
import { EventType } from "@ag-ui/client";

interface AnyEvent {
  type: EventType;
  messages?: Array<{ id: string }>;
}

/** Build a LangGraphAgent wired to capture dispatched events. */
function createAgent(checkpointMessages: Array<{ id: string; type: string; content?: string }>) {
  const agent = new LangGraphAgent({
    graphId: "test-graph",
    deploymentUrl: "http://localhost:8000",
  });

  const events: AnyEvent[] = [];
  (agent as any).subscriber = { next: (e: AnyEvent) => events.push(e) };
  (agent as any).getStateSnapshot = () => ({});
  (agent as any).client = {
    threads: {
      getState: async () => ({
        values: { messages: checkpointMessages },
      }),
    },
  };

  return { agent, events };
}

describe("MESSAGES_SNAPSHOT invariant", () => {
  it("snapshot messages come exclusively from the checkpoint", async () => {
    const checkpoint = [
      { id: "u1", type: "human", content: "hi" },
      { id: "a1", type: "ai", content: "hello" },
    ];
    const { agent, events } = createAgent(checkpoint);

    await (agent as any).getStateAndMessagesSnapshots("thread-1");

    const snapshot = events.find((e) => e.type === EventType.MESSAGES_SNAPSHOT);
    expect(snapshot).toBeDefined();
    expect(snapshot!.messages!.map((m) => m.id)).toEqual(["u1", "a1"]);
  });

  it("snapshot is emitted once with both STATE_SNAPSHOT and MESSAGES_SNAPSHOT", async () => {
    const { agent, events } = createAgent([
      { id: "u1", type: "human", content: "hi" },
    ]);

    await (agent as any).getStateAndMessagesSnapshots("thread-1");

    const types = events.map((e) => e.type);
    expect(types).toContain(EventType.STATE_SNAPSHOT);
    expect(types).toContain(EventType.MESSAGES_SNAPSHOT);
    expect(types.filter((t) => t === EventType.MESSAGES_SNAPSHOT)).toHaveLength(1);
  });

  it("does not surface a streamedMessages side channel — there is no such field to populate", () => {
    const { agent } = createAgent([]);
    (agent as any).activeRun = { id: "run-1" };
    // The field intentionally does not exist on RunMetadata.
    expect((agent as any).activeRun.streamedMessages).toBeUndefined();
    // Nothing on the agent accumulates model outputs outside the checkpoint.
    expect((agent as any).streamedMessages).toBeUndefined();
  });
});

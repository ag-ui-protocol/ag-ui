/**
 * A reasoning span still open when the run ends must be closed before the
 * terminal event. The adapter closes a span only when the NEXT model chunk
 * carries no reasoning, so a stream that stops right after a reasoning chunk
 * (a dropped connection the node tolerates) used to reach RUN_FINISHED with the
 * span still open, which the AG-UI client rejects.
 */

import { EventType } from "@ag-ui/core";
// @langchain/langgraph-sdk is a graph persistence client, not an LLM provider;
// aimock does not apply to these synthetic stream-reader tests.
import type {
  Assistant,
  EventsStreamEvent,
  ThreadState,
} from "@langchain/langgraph-sdk";
import { describe, expect, it, vi } from "vitest";
import { LangGraphAgent, type ProcessedEvents } from "./agent";

const TEST_ASSISTANT: Assistant = {
  assistant_id: "assistant-1",
  graph_id: "test-graph",
  config: {},
  context: {},
  created_at: "2026-09-01T00:00:00.000Z",
  updated_at: "2026-09-01T00:00:00.000Z",
  metadata: {},
  version: 1,
  name: "test assistant",
};

function threadState(overrides: Partial<ThreadState> = {}): ThreadState {
  return {
    values: { messages: [] },
    next: [],
    checkpoint: {
      thread_id: "thread-1",
      checkpoint_ns: "",
      checkpoint_id: null,
      checkpoint_map: null,
    },
    metadata: {},
    created_at: null,
    parent_checkpoint: null,
    tasks: [],
    ...overrides,
  };
}

function thinkingChunk(): EventsStreamEvent {
  return {
    event: "events",
    data: {
      event: "on_chat_model_stream",
      name: "test event",
      tags: [],
      run_id: "run-1",
      metadata: { langgraph_node: "think" },
      parent_ids: [],
      data: {
        chunk: {
          content: [{ type: "thinking", thinking: "Let me think" }],
          response_metadata: {},
        },
      },
    },
  };
}

async function runOnce(finalState: ThreadState) {
  const agent = new LangGraphAgent({
    deploymentUrl: "http://localhost:2024",
    graphId: "test-graph",
  });
  agent.assistant = TEST_ASSISTANT;
  async function* streamResponse() {
    // The stream stops right after the reasoning chunk: no model-end follows.
    yield thinkingChunk();
  }
  vi.spyOn(agent, "prepareStream").mockResolvedValue({
    streamResponse: streamResponse(),
    state: threadState(),
  } as any);
  vi.spyOn(agent.client.threads, "getState").mockResolvedValue(finalState);

  const events: ProcessedEvents[] = [];
  await new Promise<void>((resolve, reject) => {
    agent
      .run({
        threadId: "thread-1",
        runId: "run-1",
        state: {},
        messages: [],
        tools: [],
        context: [],
        forwardedProps: {},
      })
      .subscribe({
        next: (event) => events.push(event),
        error: reject,
        complete: resolve,
      });
  });
  return events.map((e) => e.type);
}

function expectSpanClosedBeforeTerminal(types: EventType[]) {
  const count = (t: EventType) => types.filter((x) => x === t).length;
  expect(count(EventType.REASONING_START)).toBe(1);
  expect(count(EventType.REASONING_END)).toBe(1);
  expect(count(EventType.REASONING_MESSAGE_START)).toBe(1);
  expect(count(EventType.REASONING_MESSAGE_END)).toBe(1);
  expect(types.indexOf(EventType.REASONING_MESSAGE_END)).toBeLessThan(
    types.indexOf(EventType.REASONING_END),
  );
  expect(types.at(-1)).toBe(EventType.RUN_FINISHED);
  expect(types.indexOf(EventType.REASONING_END)).toBeLessThan(
    types.indexOf(EventType.RUN_FINISHED),
  );
}

describe("reasoning span still open at the end of the run", () => {
  it("is closed before RUN_FINISHED", async () => {
    const types = await runOnce(threadState());
    expectSpanClosedBeforeTerminal(types);
  });

  it("is closed before RUN_FINISHED on the interrupt path", async () => {
    const types = await runOnce(
      threadState({
        next: ["think"],
        tasks: [
          {
            id: "task-1",
            name: "think",
            error: null,
            interrupts: [{ id: "int-1", value: { question: "approve?" } }],
            checkpoint: null,
            state: null,
            result: null,
          },
        ] as ThreadState["tasks"],
      }),
    );
    expectSpanClosedBeforeTerminal(types);
  });
});

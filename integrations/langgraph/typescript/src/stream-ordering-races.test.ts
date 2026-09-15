import {
  EventType,
  type MessagesSnapshotEvent,
  type StateSnapshotEvent,
} from "@ag-ui/core";
// @langchain/langgraph-sdk is a graph persistence client, not an LLM provider;
// aimock does not apply to these synthetic stream-reader tests.
import type {
  Assistant,
  EventsStreamEvent,
  Message as LangGraphMessage,
  MessagesTupleStreamEvent,
  ThreadState,
  ValuesStreamEvent,
} from "@langchain/langgraph-sdk";
import { describe, expect, it, vi } from "vitest";
import { LangGraphAgent, type ProcessedEvents } from "./agent";

type StreamChunk =
  | EventsStreamEvent
  | MessagesTupleStreamEvent
  | ValuesStreamEvent<ThreadState["values"]>;

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

function createAgent() {
  return new LangGraphAgent({
    deploymentUrl: "http://localhost:2024",
    graphId: "test-graph",
  });
}

function threadState(values: ThreadState["values"]): ThreadState {
  return {
    values,
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
  };
}

function eventChunk(
  event: string,
  metadata: EventsStreamEvent["data"]["metadata"],
  data: EventsStreamEvent["data"]["data"],
): EventsStreamEvent {
  return {
    event: "events",
    data: {
      event,
      name: "test event",
      tags: [],
      run_id: "run-1",
      metadata,
      parent_ids: [],
      data,
    },
  };
}

function valuesChunk(
  values: ThreadState["values"],
): ValuesStreamEvent<ThreadState["values"]> {
  return {
    event: "values",
    data: values,
  };
}

function lateMessageTuple(): MessagesTupleStreamEvent {
  const message: LangGraphMessage = {
    id: "late-message",
    type: "ai",
    content: "",
  };
  return {
    event: "messages",
    data: [message, { tags: [], langgraph_node: "tools" }],
  };
}

async function runUntilStreamError(
  agent: LangGraphAgent,
  chunks: StreamChunk[],
  initialState: ThreadState,
  forwardedProps: NonNullable<
    Parameters<LangGraphAgent["run"]>[0]["forwardedProps"]
  > = {},
) {
  const streamError = new Error("stop after inspected chunk");
  async function* streamResponse(): AsyncGenerator<StreamChunk> {
    yield* chunks;
    throw streamError;
  }

  agent.assistant = TEST_ASSISTANT;
  vi.spyOn(agent, "prepareStream").mockResolvedValue({
    streamResponse: streamResponse(),
    state: initialState,
  });

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
        forwardedProps,
      })
      .subscribe({
        next: (event) => events.push(event),
        error: (error) => {
          if (error === streamError) resolve();
          else reject(error);
        },
        complete: () => reject(new Error("stream completed before sentinel")),
      });
  });
  return events;
}

describe("load-dependent stream ordering", () => {
  it("does not let a late ignored messages tuple trigger a state snapshot", async () => {
    const agent = createAgent();
    const state = threadState({ messages: [] });

    const events = await runUntilStreamError(
      agent,
      [
        eventChunk(
          "on_chat_model_stream",
          { langgraph_node: "tools" },
          { chunk: { content: "", response_metadata: {} } },
        ),
        eventChunk(
          "on_chain_end",
          { langgraph_node: "tools" },
          { output: state.values },
        ),
        eventChunk(
          "on_tool_end",
          { langgraph_node: "tools" },
          {
            output: {
              tool_call_id: "tool-1",
              name: "test_tool",
              content: "done",
            },
          },
        ),
        lateMessageTuple(),
      ],
      state,
    );

    const tupleSnapshots = events.filter(
      (event): event is StateSnapshotEvent =>
        event.type === EventType.STATE_SNAPSHOT &&
        event.rawEvent?.event === "messages",
    );
    expect(tupleSnapshots).toEqual([]);
  });

  it("uses the pre-entry root state when live thread state is ahead", async () => {
    const agent = createAgent();
    const user: LangGraphMessage = {
      id: "user-1",
      type: "human",
      content: "Plan my trip",
    };
    const rootAssistant: LangGraphMessage = {
      id: "root-1",
      type: "ai",
      content: "I will find experiences next",
    };
    const futureExperience: LangGraphMessage = {
      id: "experience-1",
      type: "ai",
      content: "Future experiences response",
    };
    const preEntryState = threadState({
      messages: [user, rootAssistant],
      itinerary: { city: "Amsterdam" },
    });
    const getState = vi
      .spyOn(agent.client.threads, "getState")
      .mockResolvedValue(
        threadState({
          messages: [user, rootAssistant, futureExperience],
          itinerary: {
            city: "Amsterdam",
            experience: "Canal tour",
          },
        }),
      );

    const events = await runUntilStreamError(
      agent,
      [
        eventChunk(
          "on_chain_start",
          {
            langgraph_node: "experiences_agent",
            langgraph_checkpoint_ns:
              "experiences_agent:outer|experiences_agent_node:inner",
          },
          {},
        ),
      ],
      preEntryState,
    );

    expect(getState).not.toHaveBeenCalled();
    const stateSnapshot = events.find(
      (event): event is StateSnapshotEvent =>
        event.type === EventType.STATE_SNAPSHOT,
    );
    expect(stateSnapshot?.snapshot).toEqual(preEntryState.values);
    const messagesSnapshot = events.find(
      (event): event is MessagesSnapshotEvent =>
        event.type === EventType.MESSAGES_SNAPSHOT,
    );
    expect(messagesSnapshot?.messages.map((message) => message.id)).toEqual([
      "user-1",
      "root-1",
    ]);
    expect(
      messagesSnapshot?.messages.map((message) => message.id),
    ).not.toContain("experience-1");
  });

  it("does not let an early root values chunk seed future subgraph state", async () => {
    const agent = createAgent();
    const user: LangGraphMessage = {
      id: "user-1",
      type: "human",
      content: "Plan my trip",
    };
    const rootAssistant: LangGraphMessage = {
      id: "root-1",
      type: "ai",
      content: "I will find experiences next",
    };
    const futureExperience: LangGraphMessage = {
      id: "experience-1",
      type: "ai",
      content: "Future experiences response",
    };
    const preEntryState = threadState({
      messages: [user, rootAssistant],
      itinerary: { city: "Amsterdam" },
    });
    const getState = vi
      .spyOn(agent.client.threads, "getState")
      .mockResolvedValue(
        threadState({
          messages: [user, rootAssistant, futureExperience],
          itinerary: {
            city: "Amsterdam",
            experience: "Canal tour",
          },
        }),
      );

    const events = await runUntilStreamError(
      agent,
      [
        eventChunk(
          "on_chat_model_stream",
          { langgraph_node: "supervisor" },
          { chunk: { content: "", response_metadata: {} } },
        ),
        valuesChunk({
          messages: [user, rootAssistant, futureExperience],
          itinerary: {
            city: "Amsterdam",
            experience: "Canal tour",
          },
        }),
        eventChunk(
          "on_chain_start",
          {
            langgraph_node: "experiences_agent",
            langgraph_checkpoint_ns:
              "experiences_agent:outer|experiences_agent_node:inner",
          },
          {},
        ),
      ],
      preEntryState,
    );

    expect(getState).not.toHaveBeenCalled();
    const boundarySnapshot = events.find(
      (event): event is StateSnapshotEvent =>
        event.type === EventType.STATE_SNAPSHOT && event.rawEvent === undefined,
    );
    expect(boundarySnapshot?.snapshot).toEqual(preEntryState.values);
    const messagesSnapshot = events.find(
      (event): event is MessagesSnapshotEvent =>
        event.type === EventType.MESSAGES_SNAPSHOT,
    );
    expect(messagesSnapshot?.messages.map((message) => message.id)).toEqual([
      "user-1",
      "root-1",
    ]);
  });

  it("reads the completed root checkpoint when future values race ahead of subgraph entry", async () => {
    const agent = createAgent();
    const user: LangGraphMessage = {
      id: "user-1",
      type: "human",
      content: "Plan my trip",
    };
    const rootAssistant: LangGraphMessage = {
      id: "root-1",
      type: "ai",
      content: "I will find experiences next",
    };
    const futureExperience: LangGraphMessage = {
      id: "experience-1",
      type: "ai",
      content: "Future experiences response",
    };
    const preEntryState = threadState({
      messages: [user, rootAssistant],
      itinerary: { city: "Amsterdam" },
    });
    const getHistory = vi
      .spyOn(agent.client.threads, "getHistory")
      .mockResolvedValue([preEntryState]);

    const events = await runUntilStreamError(
      agent,
      [
        eventChunk(
          "on_chat_model_stream",
          { langgraph_node: "supervisor", langgraph_checkpoint_ns: "" },
          { chunk: { content: "", response_metadata: {} } },
        ),
        eventChunk(
          "on_chain_end",
          { langgraph_node: "supervisor", langgraph_checkpoint_ns: "" },
          { output: { messages: [rootAssistant] } },
        ),
        valuesChunk({
          messages: [user, rootAssistant, futureExperience],
          itinerary: { city: "Amsterdam", experience: "Canal tour" },
        }),
        eventChunk(
          "on_chain_start",
          {
            langgraph_node: "experiences_agent",
            langgraph_checkpoint_ns: "experiences_agent:outer",
            langgraph_step: 2,
          },
          {},
        ),
        eventChunk(
          "on_chain_start",
          {
            langgraph_node: "experiences_agent_node",
            langgraph_checkpoint_ns:
              "experiences_agent:outer|experiences_agent_node:inner",
            langgraph_step: 1,
          },
          {},
        ),
      ],
      threadState({ messages: [user], itinerary: { city: "Amsterdam" } }),
    );

    expect(getHistory).toHaveBeenCalledWith("thread-1", {
      limit: 1,
      metadata: { step: 1 },
    });
    const boundarySnapshot = events.find(
      (event): event is StateSnapshotEvent =>
        event.type === EventType.STATE_SNAPSHOT && event.rawEvent === undefined,
    );
    expect(boundarySnapshot?.snapshot).toEqual(preEntryState.values);
    const messagesSnapshot = events.find(
      (event): event is MessagesSnapshotEvent =>
        event.type === EventType.MESSAGES_SNAPSHOT,
    );
    expect(messagesSnapshot?.messages.map((message) => message.id)).toEqual([
      "user-1",
      "root-1",
    ]);
  });

  it("keeps existing message history when committed root values follow a node output", async () => {
    const agent = createAgent();
    const user: LangGraphMessage = {
      id: "user-1",
      type: "human",
      content: "Plan my trip",
    };
    const reply: LangGraphMessage = {
      id: "reply-1",
      type: "ai",
      content: "I will find experiences next",
    };
    const initialState = threadState({ messages: [user] });

    const events = await runUntilStreamError(
      agent,
      [
        eventChunk(
          "on_chat_model_stream",
          { langgraph_node: "planner", langgraph_checkpoint_ns: "" },
          { chunk: { content: "", response_metadata: {} } },
        ),
        eventChunk(
          "on_chain_end",
          { langgraph_node: "planner", langgraph_checkpoint_ns: "" },
          { output: { messages: [reply] } },
        ),
        valuesChunk({ messages: [user, reply] }),
        eventChunk(
          "on_chain_start",
          {
            langgraph_node: "child",
            langgraph_checkpoint_ns: "child:outer|inner:task",
          },
          {},
        ),
      ],
      initialState,
    );

    const messagesSnapshot = events.find(
      (event): event is MessagesSnapshotEvent =>
        event.type === EventType.MESSAGES_SNAPSHOT,
    );
    expect(messagesSnapshot?.messages.map((message) => message.id)).toEqual([
      "user-1",
      "reply-1",
    ]);
  });

  it("keeps reducer-accumulated state from committed root values", async () => {
    const agent = createAgent();

    const events = await runUntilStreamError(
      agent,
      [
        eventChunk(
          "on_chat_model_stream",
          { langgraph_node: "planner", langgraph_checkpoint_ns: "" },
          { chunk: { content: "", response_metadata: {} } },
        ),
        eventChunk(
          "on_chain_end",
          { langgraph_node: "planner", langgraph_checkpoint_ns: "" },
          { output: { total: 1 } },
        ),
        valuesChunk({ messages: [], total: 8 }),
        eventChunk(
          "on_chain_start",
          {
            langgraph_node: "child",
            langgraph_checkpoint_ns: "child:outer|inner:task",
          },
          {},
        ),
      ],
      threadState({ messages: [], total: 7 }),
    );

    const boundarySnapshot = events.find(
      (event): event is StateSnapshotEvent =>
        event.type === EventType.STATE_SNAPSHOT && event.rawEvent === undefined,
    );
    expect(boundarySnapshot?.snapshot.total).toBe(8);
  });

  it("does not let helper callback output reject reduced root values", async () => {
    const agent = createAgent();
    const user: LangGraphMessage = {
      id: "user-1",
      type: "human",
      content: "Plan my trip",
    };
    const reply: LangGraphMessage = {
      id: "reply-1",
      type: "ai",
      content: "I will find experiences next",
    };

    const events = await runUntilStreamError(
      agent,
      [
        eventChunk(
          "on_chat_model_stream",
          { langgraph_node: "writer", langgraph_checkpoint_ns: "" },
          { chunk: { content: "", response_metadata: {} } },
        ),
        eventChunk(
          "on_chain_end",
          { langgraph_node: "writer", langgraph_checkpoint_ns: "" },
          { output: { temporary: "working" } },
        ),
        eventChunk(
          "on_chain_end",
          { langgraph_node: "writer", langgraph_checkpoint_ns: "" },
          { output: { messages: [reply], total: 1 } },
        ),
        eventChunk(
          "on_chain_start",
          {
            langgraph_node: "child",
            langgraph_checkpoint_ns: "child:outer",
          },
          {},
        ),
        valuesChunk({ messages: [user, reply], total: 8 }),
        eventChunk(
          "on_chain_start",
          {
            langgraph_node: "child",
            langgraph_checkpoint_ns: "child:outer|inner:task",
          },
          {},
        ),
      ],
      threadState({ messages: [user], total: 7 }),
    );

    const messagesSnapshot = events.find(
      (event): event is MessagesSnapshotEvent =>
        event.type === EventType.MESSAGES_SNAPSHOT,
    );
    expect(messagesSnapshot?.messages.map((message) => message.id)).toEqual([
      "user-1",
      "reply-1",
    ]);
    const boundarySnapshot = events.find(
      (event): event is StateSnapshotEvent =>
        event.type === EventType.STATE_SNAPSHOT && event.rawEvent === undefined,
    );
    expect(boundarySnapshot?.snapshot.total).toBe(8);
  });

  it.each([false, true])(
    "reads reduced state before a second subgraph in events-only mode (model callback: %s)",
    async (modelStreamSeen) => {
      const agent = createAgent();
      const user: LangGraphMessage = {
        id: "user-1",
        type: "human",
        content: "Plan my trip",
      };
      const childReply: LangGraphMessage = {
        id: "child-1",
        type: "ai",
        content: "I found the first result",
      };
      const writerReply: LangGraphMessage = {
        id: "writer-1",
        type: "ai",
        content: "I will find the second result",
      };
      const afterFirstChild = threadState({
        messages: [user, childReply],
        total: 7,
      });
      const afterWriter = threadState({
        messages: [user, childReply, writerReply],
        total: 8,
      });
      vi.spyOn(agent.client.threads, "getHistory").mockResolvedValue([
        afterFirstChild,
      ]);
      vi.spyOn(agent.client.threads, "getState").mockResolvedValue(afterWriter);

      const events = await runUntilStreamError(
        agent,
        [
          ...(modelStreamSeen
            ? [
                eventChunk(
                  "on_chat_model_stream",
                  {
                    langgraph_node: "supervisor",
                    langgraph_checkpoint_ns: "",
                  },
                  { chunk: { content: "", response_metadata: {} } },
                ),
              ]
            : []),
          eventChunk(
            "on_chain_start",
            {
              langgraph_node: "child1",
              langgraph_checkpoint_ns: "child1:outer|inner:task",
            },
            {},
          ),
          eventChunk(
            "on_chain_end",
            {
              langgraph_node: "child1",
              langgraph_checkpoint_ns: "child1:outer|inner:task",
            },
            { output: { messages: [childReply] } },
          ),
          eventChunk(
            "on_chain_start",
            {
              langgraph_node: "writer",
              langgraph_checkpoint_ns: "writer:task",
              langgraph_step: 2,
            },
            {},
          ),
          eventChunk(
            "on_chain_end",
            {
              langgraph_node: "writer",
              langgraph_checkpoint_ns: "writer:task",
            },
            { output: { messages: [writerReply], total: 1 } },
          ),
          eventChunk(
            "on_chain_start",
            {
              langgraph_node: "child2",
              langgraph_checkpoint_ns: "child2:outer|inner:task",
            },
            {},
          ),
        ],
        threadState({ messages: [user], total: 7 }),
        { streamMode: ["events"] },
      );

      const messagesSnapshots = events.filter(
        (event): event is MessagesSnapshotEvent =>
          event.type === EventType.MESSAGES_SNAPSHOT,
      );
      expect(
        messagesSnapshots.at(-1)?.messages.map((message) => message.id),
      ).toEqual(["user-1", "child-1", "writer-1"]);
      const boundarySnapshots = events.filter(
        (event): event is StateSnapshotEvent =>
          event.type === EventType.STATE_SNAPSHOT &&
          event.rawEvent === undefined,
      );
      expect(boundarySnapshots.at(-1)?.snapshot.total).toBe(8);
    },
  );

  it("uses committed root values when a subgraph returns with exit durability", async () => {
    const agent = createAgent();
    const user: LangGraphMessage = {
      id: "user-1",
      type: "human",
      content: "Plan my trip",
    };
    const reply: LangGraphMessage = {
      id: "reply-1",
      type: "ai",
      content: "I found a hotel",
    };
    const getState = vi.spyOn(agent.client.threads, "getState");
    const getHistory = vi.spyOn(agent.client.threads, "getHistory");

    const events = await runUntilStreamError(
      agent,
      [
        eventChunk(
          "on_chat_model_stream",
          { langgraph_node: "supervisor", langgraph_checkpoint_ns: "" },
          { chunk: { content: "", response_metadata: {} } },
        ),
        eventChunk(
          "on_chain_start",
          {
            langgraph_node: "child",
            langgraph_checkpoint_ns: "child:outer|inner:task",
          },
          {},
        ),
        eventChunk(
          "on_chain_end",
          {
            langgraph_node: "child",
            langgraph_checkpoint_ns: "child:outer|inner:task",
          },
          { output: { messages: [reply] } },
        ),
        valuesChunk({ messages: [user, reply] }),
        eventChunk(
          "on_chain_start",
          {
            langgraph_node: "next_root",
            langgraph_checkpoint_ns: "next_root:task",
            langgraph_step: 3,
          },
          {},
        ),
      ],
      threadState({ messages: [user] }),
      { durability: "exit" },
    );

    expect(getState).not.toHaveBeenCalled();
    expect(getHistory).not.toHaveBeenCalled();
    const messagesSnapshots = events.filter(
      (event): event is MessagesSnapshotEvent =>
        event.type === EventType.MESSAGES_SNAPSHOT,
    );
    expect(
      messagesSnapshots.at(-1)?.messages.map((message) => message.id),
    ).toEqual(["user-1", "reply-1"]);
  });

  it("does not replace a populated root boundary with an empty values pulse", async () => {
    const agent = createAgent();
    const user: LangGraphMessage = {
      id: "user-1",
      type: "human",
      content: "Plan my trip",
    };
    const initialState = threadState({
      messages: [user],
      itinerary: null,
      tools: [],
    });
    const getHistory = vi
      .spyOn(agent.client.threads, "getHistory")
      .mockResolvedValue([initialState]);

    const events = await runUntilStreamError(
      agent,
      [
        eventChunk(
          "on_chat_model_stream",
          { langgraph_node: "supervisor", langgraph_checkpoint_ns: "" },
          { chunk: { content: "", response_metadata: {} } },
        ),
        eventChunk(
          "on_chain_start",
          {
            langgraph_node: "child",
            langgraph_checkpoint_ns: "child:outer|inner:task",
          },
          {},
        ),
        eventChunk(
          "on_chain_end",
          {
            langgraph_node: "child",
            langgraph_checkpoint_ns: "child:outer|inner:task",
          },
          { output: initialState.values },
        ),
        valuesChunk({}),
        eventChunk(
          "on_chain_start",
          {
            langgraph_node: "next_root",
            langgraph_checkpoint_ns: "next_root:task",
            langgraph_step: 3,
          },
          {},
        ),
      ],
      initialState,
    );

    const messagesSnapshots = events.filter(
      (event): event is MessagesSnapshotEvent =>
        event.type === EventType.MESSAGES_SNAPSHOT,
    );
    expect(
      messagesSnapshots.at(-1)?.messages.map((message) => message.id),
    ).toEqual(["user-1"]);
    const boundarySnapshots = events.filter(
      (event): event is StateSnapshotEvent =>
        event.type === EventType.STATE_SNAPSHOT && event.rawEvent === undefined,
    );
    expect(boundarySnapshots.at(-1)?.snapshot).toEqual(initialState.values);
    expect(getHistory).toHaveBeenCalledWith("thread-1", {
      limit: 1,
      metadata: { step: 2 },
    });
  });

  it("seeds the first subgraph boundary from root on_chain_end object output without a values chunk", async () => {
    const agent = createAgent();
    const user: LangGraphMessage = {
      id: "user-1",
      type: "human",
      content: "Plan my trip",
    };
    const preEntryState = threadState({
      messages: [user],
      itinerary: { city: "Amsterdam" },
    });
    const getState = vi
      .spyOn(agent.client.threads, "getState")
      .mockResolvedValue(
        threadState({
          messages: [
            user,
            { id: "live-1", type: "ai", content: "Live thread state" },
          ],
          itinerary: { city: "Rotterdam" },
        }),
      );

    const events = await runUntilStreamError(
      agent,
      [
        eventChunk(
          "on_chain_end",
          { langgraph_node: "planner", langgraph_checkpoint_ns: "" },
          { output: { itinerary: { city: "Amsterdam", hotel: "Hotel Zoe" } } },
        ),
        eventChunk(
          "on_chain_start",
          {
            langgraph_node: "experiences_agent",
            langgraph_checkpoint_ns:
              "experiences_agent:outer|experiences_agent_node:inner",
          },
          {},
        ),
      ],
      preEntryState,
    );

    expect(getState).not.toHaveBeenCalled();
    // The boundary snapshot is the one without a rawEvent; per-chunk node
    // change snapshots carry the triggering chunk.
    const boundarySnapshot = events.find(
      (event): event is StateSnapshotEvent =>
        event.type === EventType.STATE_SNAPSHOT && event.rawEvent === undefined,
    );
    expect(boundarySnapshot?.snapshot).toEqual({
      messages: [user],
      itinerary: { city: "Amsterdam", hotel: "Hotel Zoe" },
    });
    const messagesSnapshot = events.find(
      (event): event is MessagesSnapshotEvent =>
        event.type === EventType.MESSAGES_SNAPSHOT,
    );
    expect(messagesSnapshot?.messages.map((message) => message.id)).toEqual([
      "user-1",
    ]);
  });

  it("seeds the first subgraph boundary from root on_chain_end Command.update without a values chunk", async () => {
    const agent = createAgent();
    const user: LangGraphMessage = {
      id: "user-1",
      type: "human",
      content: "Plan my trip",
    };
    const preEntryState = threadState({
      messages: [user],
      itinerary: { city: "Amsterdam" },
    });
    const getState = vi
      .spyOn(agent.client.threads, "getState")
      .mockResolvedValue(
        threadState({
          messages: [
            user,
            { id: "live-1", type: "ai", content: "Live thread state" },
          ],
          itinerary: { city: "Rotterdam" },
        }),
      );

    const events = await runUntilStreamError(
      agent,
      [
        eventChunk(
          "on_chain_end",
          { langgraph_node: "planner", langgraph_checkpoint_ns: "" },
          {
            output: [
              {
                lg_name: "Command",
                update: {
                  itinerary: { city: "Amsterdam", hotel: "Hotel Zoe" },
                },
              },
            ],
          },
        ),
        eventChunk(
          "on_chain_start",
          {
            langgraph_node: "experiences_agent",
            langgraph_checkpoint_ns:
              "experiences_agent:outer|experiences_agent_node:inner",
          },
          {},
        ),
      ],
      preEntryState,
    );

    expect(getState).not.toHaveBeenCalled();
    const boundarySnapshot = events.find(
      (event): event is StateSnapshotEvent =>
        event.type === EventType.STATE_SNAPSHOT && event.rawEvent === undefined,
    );
    expect(boundarySnapshot?.snapshot).toEqual({
      messages: [user],
      itinerary: { city: "Amsterdam", hotel: "Hotel Zoe" },
    });
    const messagesSnapshot = events.find(
      (event): event is MessagesSnapshotEvent =>
        event.type === EventType.MESSAGES_SNAPSHOT,
    );
    expect(messagesSnapshot?.messages.map((message) => message.id)).toEqual([
      "user-1",
    ]);
  });
});

import { expect, it, vi } from "vitest";
import {
  Annotation,
  StateGraph,
  START,
  type ProtocolEvent,
} from "@langchain/langgraph";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { aguiTransformer } from "./agui-transformer";
import type { ProcessedEvents } from "../types";

const State = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (left, right) => left.concat(right),
    default: () => [],
  }),
});

async function capture(
  stream: AsyncIterable<ProtocolEvent>,
  options: {
    fails?: boolean;
    nodeOrigin?: boolean;
    onMessageFinish?: () => void;
  } = {},
) {
  const transformer = aguiTransformer();
  const { agui } = await transformer.init();
  const events: ProcessedEvents[] = [];
  vi.spyOn(agui, "push").mockImplementation((event) => {
    events.push(event);
  });
  const consume = async () => {
    for await (const event of stream) {
      const data = event.params.data;
      // Every producer in these model-free graphs returns node messages.
      // Exercise the explicit provenance contract on older runtimes too.
      if (
        options.nodeOrigin &&
        event.method === "messages" &&
        typeof data === "object" &&
        data &&
        "event" in data &&
        data.event === "message-start"
      ) {
        transformer.process({
          ...event,
          params: {
            ...event.params,
            data: {
              ...data,
              metadata: { langgraph_message_source: "node" },
            },
          },
        });
      } else transformer.process(event);
      if (
        event.method === "messages" &&
        typeof data === "object" &&
        data &&
        "event" in data &&
        data.event === "message-finish"
      )
        options.onMessageFinish?.();
    }
  };
  if (options.fails) await expect(consume()).rejects.toThrow("boom");
  else await consume();
  transformer.finalize?.();
  return events.filter(
    (event) =>
      !(
        event.type === "CUSTOM" && event.name === "__ag_ui_transformer_status__"
      ),
  );
}

function expectBalancedSteps(events: ProcessedEvents[]) {
  const active = new Set<string>();
  for (const event of events) {
    if (event.type === "STEP_STARTED") {
      expect(
        active.has(event.stepName),
        `duplicate start: ${event.stepName}`,
      ).toBe(false);
      active.add(event.stepName);
    } else if (event.type === "STEP_FINISHED") {
      expect(
        active.delete(event.stepName),
        `unmatched finish: ${event.stepName}`,
      ).toBe(true);
    }
  }
  expect([...active]).toEqual([]);
}

it.each([false, true])(
  "balances three nested levels on failure=%s",
  async (fails) => {
    const leaf = new StateGraph(State)
      .addNode("leaf", () => {
        if (fails) throw new Error("boom");
        return { messages: [] };
      })
      .addEdge(START, "leaf")
      .compile();
    const middle = new StateGraph(State)
      .addNode("middle", leaf)
      .addEdge(START, "middle")
      .compile();
    const graph = new StateGraph(State)
      .addNode("outer", middle)
      .addEdge(START, "outer")
      .compile();
    expectBalancedSteps(
      await capture(
        await graph.streamEvents({ messages: [] }, { version: "v3" }),
        { fails },
      ),
    );
  },
);

it("shares active step names between a root task and a parallel nested task", async () => {
  const child = new StateGraph(State)
    .addNode("worker", () => ({ messages: [] }))
    .addEdge(START, "worker")
    .compile();
  const graph = new StateGraph(State)
    .addNode("outer", child)
    .addNode("worker", () => ({ messages: [] }))
    .addEdge(START, "outer")
    .addEdge(START, "worker")
    .compile();
  expectBalancedSteps(
    await capture(
      await graph.streamEvents({ messages: [] }, { version: "v3" }),
    ),
  );
});

it("retains received node message frames when a parallel child fails", async () => {
  let releaseFailure!: () => void;
  const messageReceived = new Promise<void>((resolve) => {
    releaseFailure = resolve;
  });
  const child = new StateGraph(State)
    .addNode("writer", () => ({
      messages: [new AIMessage({ content: "visible", id: "returned" })],
    }))
    .addNode("fail", async () => {
      await messageReceived;
      throw new Error("boom");
    })
    .addEdge(START, "writer")
    .addEdge(START, "fail")
    .compile();
  const graph = new StateGraph(State)
    .addNode("outer", child)
    .addEdge(START, "outer")
    .compile();
  const events = await capture(
    await graph.streamEvents({ messages: [] }, { version: "v3" }),
    {
      fails: true,
      nodeOrigin: true,
      onMessageFinish: releaseFailure,
    },
  );
  expect(
    events.filter((event) => event.type === "TEXT_MESSAGE_CONTENT"),
  ).toEqual([
    { type: "TEXT_MESSAGE_CONTENT", messageId: "returned", delta: "visible" },
  ]);
  expectBalancedSteps(events);
  const errorIndex = events.findIndex((event) => event.type === "RUN_ERROR");
  if (errorIndex >= 0) expect(errorIndex).toBe(events.length - 1);
});

it("tracks identically named suspended parents in separate subgraph scopes", async () => {
  const leaf = new StateGraph(State)
    .addNode("leaf", () => ({ messages: [] }))
    .addEdge(START, "leaf")
    .compile();
  const child = new StateGraph(State)
    .addNode("middle", leaf)
    .addEdge(START, "middle")
    .compile();
  const graph = new StateGraph(State)
    .addNode("left", child)
    .addNode("right", child)
    .addEdge(START, "left")
    .addEdge(START, "right")
    .compile();
  expectBalancedSteps(
    await capture(
      await graph.streamEvents({ messages: [] }, { version: "v3" }),
    ),
  );
});

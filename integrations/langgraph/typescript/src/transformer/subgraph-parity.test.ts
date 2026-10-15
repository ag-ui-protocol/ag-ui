import { it, expect, vi } from "vitest";
import {
  Annotation,
  StateGraph,
  START,
  END,
  messagesStateReducer,
  interrupt,
  MemorySaver,
  Command,
} from "@langchain/langgraph";
import {
  AIMessage,
  HumanMessage,
  type BaseMessage,
} from "@langchain/core/messages";

import { aguiTransformer } from "./agui-transformer";
import { EventType } from "@ag-ui/core";
import type { ProcessedEvents } from "../types";

it.each([
  { marked: false, command: false },
  { marked: true, command: false },
  { marked: true, command: true },
])(
  "restores parent steps and groups returned messages ($marked, command $command)",
  async ({ marked, command }) => {
    const State = Annotation.Root({
      messages: Annotation<BaseMessage[]>({
        reducer: messagesStateReducer,
        default: () => [],
      }),
    });
    const child = new StateGraph(State)
      .addNode("inner", () => {
        const update = {
          messages: [
            new AIMessage({ content: "one", id: "one" }),
            new AIMessage({ content: "two", id: "two" }),
          ],
        };
        return command ? new Command({ update, goto: END }) : update;
      })
      .addEdge(START, "inner")
      .addEdge("inner", END)
      .compile();
    const graph = new StateGraph(State)
      .addNode("outer", child)
      .addEdge(START, "outer")
      .addEdge("outer", END)
      .compile();
    const stream = await graph.streamEvents(
      { messages: [new HumanMessage({ content: "hi", id: "human" })] },
      { version: "v3" },
    );
    const transformer = aguiTransformer();
    const { agui } = await transformer.init();
    const events: ProcessedEvents[] = [];
    vi.spyOn(agui, "push").mockImplementation((event) => {
      events.push(event);
    });
    for await (const event of stream) {
      // Model-free graph: annotate its genuine node output frames with the
      // upstream producer metadata, also covering older unmarked runtimes.
      const data = event.params.data;
      if (
        marked &&
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
            data: { ...data, metadata: { langgraph_message_source: "node" } },
          },
        });
      } else transformer.process(event);
    }
    if (marked) {
      const firstText = events.findIndex(
        (e) => e.type === EventType.TEXT_MESSAGE_START,
      );
      const childEnd = events.findIndex(
        (e) => e.type === EventType.STEP_FINISHED && e.stepName === "inner",
      );
      expect(firstText).toBeGreaterThan(childEnd);
      expect(
        events.findIndex(
          (event) =>
            event.type === EventType.MESSAGES_SNAPSHOT &&
            event.messages.length === 3,
        ),
      ).toBeGreaterThan(firstText);
    }
    transformer.finalize?.();
    expect(
      events
        .filter(
          (e) =>
            e.type === EventType.STEP_STARTED ||
            e.type === EventType.STEP_FINISHED,
        )
        .map((e) => [e.type, e.stepName]),
    ).toEqual([
      ["STEP_STARTED", "outer"],
      ["STEP_FINISHED", "outer"],
      ["STEP_STARTED", "inner"],
      ["STEP_FINISHED", "inner"],
      ["STEP_STARTED", "outer"],
      ["STEP_FINISHED", "outer"],
    ]);
    expect(
      events.filter((e) => e.type === EventType.TEXT_MESSAGE_START),
    ).toEqual([
      { type: "TEXT_MESSAGE_START", messageId: "one", role: "assistant" },
    ]);
    expect(
      events.filter((e) => e.type === EventType.TEXT_MESSAGE_CONTENT),
    ).toEqual([
      { type: "TEXT_MESSAGE_CONTENT", messageId: "one", delta: "one" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "one", delta: "two" },
    ]);
    expect(
      events
        .filter((e) => e.type === EventType.MESSAGES_SNAPSHOT)
        .map((e) => e.messages.length),
    ).toEqual([1, 3, 3]);
  },
);

it("balances nested steps at interrupt and resumes without losing returned text", async () => {
  const State = Annotation.Root({
    messages: Annotation<BaseMessage[]>({
      reducer: messagesStateReducer,
      default: () => [],
    }),
  });
  const child = new StateGraph(State)
    .addNode("choose", () => {
      const choice = interrupt("choose");
      return {
        messages: [new AIMessage({ content: String(choice), id: "choice" })],
      };
    })
    .addEdge(START, "choose")
    .addEdge("choose", END)
    .compile();
  const graph = new StateGraph(State)
    .addNode("outer", child)
    .addEdge(START, "outer")
    .addEdge("outer", END)
    .compile({ checkpointer: new MemorySaver() });
  const config = {
    version: "v3" as const,
    configurable: { thread_id: "nested" },
  };
  for (const input of [
    { messages: [new HumanMessage({ content: "hi", id: "human" })] },
    new Command<unknown, typeof State.Update, "outer" | "__start__">({
      resume: "chosen",
    }),
  ]) {
    const transformer = aguiTransformer();
    const { agui } = await transformer.init();
    const events: ProcessedEvents[] = [];
    vi.spyOn(agui, "push").mockImplementation((event) => {
      events.push(event);
    });
    for await (const event of await graph.streamEvents(input, config))
      transformer.process(event);
    transformer.finalize?.();
    const steps = events.filter(
      (e) =>
        e.type === EventType.STEP_STARTED || e.type === EventType.STEP_FINISHED,
    );
    const active = new Set<string>();
    for (const step of steps) {
      if (step.type === EventType.STEP_STARTED) {
        expect(active.has(step.stepName)).toBe(false);
        active.add(step.stepName);
      } else {
        expect(active.has(step.stepName)).toBe(true);
        active.delete(step.stepName);
      }
    }
    expect(active.size).toBe(0);
    expect(
      events
        .filter((e) => e.type === EventType.MESSAGES_SNAPSHOT)
        .map((e) => e.messages.length),
    ).toEqual(input instanceof Command ? [1, 2, 2] : [1, 1, 1]);
  }
});

it("keeps consecutive invocations of the same root node in one step", async () => {
  const State = Annotation.Root({ count: Annotation<number> });
  const graph = new StateGraph(State)
    .addNode(
      "repeat",
      ({ count }) =>
        new Command({
          update: { count: count + 1 },
          goto: count ? END : "repeat",
        }),
      { ends: ["repeat", END] },
    )
    .addEdge(START, "repeat")
    .compile();
  const transformer = aguiTransformer();
  const { agui } = await transformer.init();
  const events: ProcessedEvents[] = [];
  vi.spyOn(agui, "push").mockImplementation((event) => {
    events.push(event);
  });
  for await (const event of await graph.streamEvents(
    { count: 0 },
    { version: "v3" },
  ))
    transformer.process(event);
  transformer.finalize?.();
  expect(
    events.filter(
      (e) =>
        e.type === EventType.STEP_STARTED || e.type === EventType.STEP_FINISHED,
    ),
  ).toEqual([
    { type: EventType.STEP_STARTED, stepName: "repeat" },
    { type: EventType.STEP_FINISHED, stepName: "repeat" },
  ]);
});

it.each([undefined, "model"])(
  "streams nested model tokens before child completion (origin %s)",
  async (source) => {
    const { BaseChatModel } = await import(
      "@langchain/core/language_models/chat_models"
    );
    const { AIMessageChunk } = await import("@langchain/core/messages");
    const { ChatGenerationChunk } = await import("@langchain/core/outputs");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let completed = false;
    class GatedModel extends BaseChatModel {
      _llmType() {
        return "gated";
      }
      async _generate(): Promise<never> {
        throw new Error("Expected native streaming");
      }
      async *_streamResponseChunks() {
        yield new ChatGenerationChunk({
          text: "first",
          message: new AIMessageChunk({ content: "first" }),
        });
        await gate;
        yield new ChatGenerationChunk({
          text: "second",
          message: new AIMessageChunk({ content: "second" }),
        });
        completed = true;
      }
    }
    const State = Annotation.Root({
      messages: Annotation<BaseMessage[]>({
        reducer: messagesStateReducer,
        default: () => [],
      }),
    });
    const model = new GatedModel({});
    const child = new StateGraph(State)
      .addNode("model", async (state) => ({
        messages: [await model.invoke(state.messages)],
      }))
      .addEdge(START, "model")
      .addEdge("model", END)
      .compile();
    const graph = new StateGraph(State)
      .addNode("outer", child)
      .addEdge(START, "outer")
      .addEdge("outer", END)
      .compile();
    const transformer = aguiTransformer();
    const { agui } = await transformer.init();
    const deltas: string[] = [];
    const events: ProcessedEvents[] = [];
    vi.spyOn(agui, "push").mockImplementation((event) => {
      events.push(event);
      if (event.type === EventType.TEXT_MESSAGE_CONTENT) {
        deltas.push(event.delta);
        if (deltas.length === 1) {
          expect(completed).toBe(false);
          release();
        }
      }
    });
    try {
      for await (const event of await graph.streamEvents(
        { messages: [new HumanMessage("hi")] },
        { version: "v3" },
      )) {
        const data = event.params.data;
        if (
          source &&
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
              data: { ...data, metadata: { langgraph_message_source: source } },
            },
          });
        } else transformer.process(event);
      }
      expect(deltas).toEqual(["first", "second"]);
      if (source)
        expect(
          events.findIndex(
            (event) => event.type === EventType.TEXT_MESSAGE_END,
          ),
        ).toBeLessThan(
          events.findIndex(
            (event) =>
              event.type === EventType.STEP_FINISHED &&
              event.stepName === "model",
          ),
        );
    } finally {
      release();
    }
  },
);

it("publishes a reduced state update inside the next root step", async () => {
  const State = Annotation.Root({ count: Annotation<number> });
  const graph = new StateGraph(State)
    .addNode(
      "initialize",
      () => new Command({ update: { count: 1 }, goto: "consume" }),
      { ends: ["consume"] },
    )
    .addNode("consume", () => ({}))
    .addEdge(START, "initialize")
    .addEdge("consume", END)
    .compile();
  const transformer = aguiTransformer();
  const { agui } = await transformer.init();
  const events: ProcessedEvents[] = [];
  vi.spyOn(agui, "push").mockImplementation((event) => {
    events.push(event);
  });
  for await (const event of await graph.streamEvents(
    { count: 0 },
    { version: "v3" },
  ))
    transformer.process(event);
  const changed = events.findIndex(
    (event) =>
      event.type === EventType.STATE_SNAPSHOT && event.snapshot.count === 1,
  );
  const started = events.findIndex(
    (event) =>
      event.type === EventType.STEP_STARTED && event.stepName === "consume",
  );
  expect(changed).toBeGreaterThan(started);
});

it("emits Command messages at the resumed containing scope in a three-level graph", async () => {
  const State = Annotation.Root({
    messages: Annotation<BaseMessage[]>({
      reducer: messagesStateReducer,
      default: () => [],
    }),
  });
  const leaf = new StateGraph(State)
    .addNode(
      "leaf",
      () =>
        new Command({
          update: {
            messages: [new AIMessage({ content: "inside", id: "inside" })],
          },
          goto: END,
        }),
    )
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
  const transformer = aguiTransformer();
  const { agui } = await transformer.init();
  const events: ProcessedEvents[] = [];
  vi.spyOn(agui, "push").mockImplementation((event) => {
    events.push(event);
  });
  for await (const event of await graph.streamEvents(
    { messages: [] },
    { version: "v3" },
  )) {
    const data = event.params.data;
    if (
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
          data: { ...data, metadata: { langgraph_message_source: "node" } },
        },
      });
    } else transformer.process(event);
  }
  const text = events.findIndex(
    (event) => event.type === EventType.TEXT_MESSAGE_CONTENT,
  );
  const lastMiddleFinish = events.findLastIndex(
    (event) =>
      event.type === EventType.STEP_FINISHED && event.stepName === "middle",
  );
  expect(text).toBeGreaterThan(-1);
  expect(text).toBeLessThan(lastMiddleFinish);
});

it("uses genuine plain-output provenance at a live graph boundary", async () => {
  const State = Annotation.Root({ count: Annotation<number> });
  const graph = new StateGraph(State)
    .addNode("produce", () => ({ count: 1 }))
    .addNode("consume", () => ({}))
    .addEdge(START, "produce")
    .addEdge("produce", "consume")
    .addEdge("consume", END)
    .compile();
  const transformer = aguiTransformer();
  const { agui } = await transformer.init();
  const events: ProcessedEvents[] = [];
  let outputType: unknown;
  vi.spyOn(agui, "push").mockImplementation((event) => {
    events.push(event);
  });
  for await (const event of await graph.streamEvents(
    { count: 0 },
    { version: "v3" },
  )) {
    const data = event.params.data;
    if (
      event.method === "tasks" &&
      typeof data === "object" &&
      data &&
      "name" in data &&
      data.name === "produce" &&
      "result" in data
    )
      outputType = "output_type" in data ? data.output_type : undefined;
    transformer.process(event);
  }
  const changed = events.findIndex(
    (event) =>
      event.type === EventType.STATE_SNAPSHOT && event.snapshot.count === 1,
  );
  const finished = events.findIndex(
    (event) =>
      event.type === EventType.STEP_FINISHED && event.stepName === "produce",
  );
  expect(changed).toBeGreaterThan(-1);
  // Older runtimes do not expose return provenance. Their normalized writes
  // cannot authorize a provisional snapshot; the next reduced state does.
  if (outputType === "Object") expect(changed).toBeLessThan(finished);
  else expect(changed).toBeGreaterThan(finished);
});

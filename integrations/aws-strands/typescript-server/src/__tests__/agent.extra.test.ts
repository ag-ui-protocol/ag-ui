import {
  createStream,
  pushStreamFactory,
  resetStreamFactories,
  setupUuidMockSequence,
} from "./agent-mocks";
import { StrandsAgent } from "../agent";
import { EventType, RunAgentInput } from "../types";

describe("StrandsAgent additional coverage", () => {
  beforeEach(() => {
    resetStreamFactories();
    setupUuidMockSequence();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("applies builder text to content blocks when binary attachments exist", async () => {
    let receivedInput: unknown;
    pushStreamFactory((input) => {
      receivedInput = input;
      return createStream([]);
    });

    const agent = new StrandsAgent(
      { model: "mock-model" } as any,
      "Binary Builder",
      "",
      {
        stateContextBuilder: () => "rewritten",
      }
    );

    const input: RunAgentInput = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "orig" },
            { type: "binary", mimeType: "image/png", url: "https://files/a.png" },
          ],
        },
      ],
    };

    const events: EventType[] = [];
    for await (const event of agent.run(input)) {
      events.push(event.type);
    }

    expect(events.at(-1)).toBe(EventType.RUN_FINISHED);
    expect(Array.isArray(receivedInput)).toBe(true);
    const blocks = receivedInput as Array<{ text?: string }>;
    expect(blocks[0]?.text).toBe("rewritten");
  });

  it("skips init/start event loop signals and stops on force_stop", async () => {
    pushStreamFactory(() =>
      createStream([
        { init_event_loop: true },
        { delta: "hi" },
        { force_stop: true },
        { delta: "ignored" },
      ])
    );

    const agent = new StrandsAgent(
      { model: "mock" } as any,
      "Loop Agent"
    );

    const events: EventType[] = [];
    for await (const event of agent.run({ messages: [{ role: "user", content: "go" }] })) {
      events.push(event.type);
    }

    expect(events).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED,
    ]);
  });

  it("stops streaming after tool result when a message was already started", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    pushStreamFactory(() =>
      createStream([
        { delta: "hello" },
        {
          current_tool_use: {
            name: "Stopper",
            toolUseId: "stop-1",
            input: "{}",
          },
        },
        { event: { contentBlockStop: {} } },
        {
          message: {
            role: "user",
            content: [
              {
                toolResult: {
                  toolUseId: "stop-1",
                  content: [{ text: "{}" }],
                },
              },
            ],
          },
        },
        { delta: "after" },
      ])
    );

    const agent = new StrandsAgent(
      { model: "mock" } as any,
      "Stop Agent",
      "",
      {
        toolBehaviors: {
          Stopper: { stopStreamingAfterResult: true },
        },
      }
    );

    const events: EventType[] = [];
    for await (const event of agent.run({ messages: [{ role: "user", content: "hi" }] })) {
      events.push(event.type);
    }

    expect(events).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.TOOL_CALL_RESULT,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED,
    ]);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("skips tool results missing ids or text content", async () => {
    pushStreamFactory(() =>
      createStream([
        {
          message: {
            role: "user",
            content: [{ toolResult: { content: [{}] } }],
          },
        },
      ])
    );

    const agent = new StrandsAgent(
      { model: "mock" } as any,
      "Skip Agent"
    );

    const events: EventType[] = [];
    for await (const event of agent.run({ messages: [{ role: "user", content: "x" }] })) {
      events.push(event.type);
    }

    expect(events).toEqual([EventType.RUN_STARTED, EventType.RUN_FINISHED]);
  });

  it("skips tool results when content text is missing but id exists", async () => {
    pushStreamFactory(() =>
      createStream([
        {
          message: {
            role: "user",
            content: [
              {
                toolResult: {
                  toolUseId: "t2",
                  content: [{ foo: "bar" }],
                },
              },
            ],
          },
        },
      ])
    );

    const agent = new StrandsAgent(
      { model: "mock" } as any,
      "Skip Text Agent"
    );

    const events: EventType[] = [];
    for await (const event of agent.run({ messages: [{ role: "user", content: "x" }] })) {
      events.push(event.type);
    }

    expect(events).toEqual([EventType.RUN_STARTED, EventType.RUN_FINISHED]);
  });

  it("warns when stateFromResult or customResultHandler throw", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);

    pushStreamFactory(() =>
      createStream([
        {
          current_tool_use: {
            name: "Flaky",
            toolUseId: "t1",
            input: "{}",
          },
        },
        { event: { contentBlockStop: {} } },
        {
          message: {
            role: "user",
            content: [
              {
                toolResult: {
                  toolUseId: "t1",
                  content: [{ text: "{}" }],
                },
              },
            ],
          },
        },
      ])
    );

    const agent = new StrandsAgent(
      { model: "mock" } as any,
      "Warn Agent",
      "",
      {
        toolBehaviors: {
          Flaky: {
            stateFromResult: () => {
              throw new Error("bad result");
            },
            customResultHandler: async function* () {
              throw new Error("bad handler");
            },
          },
        },
      }
    );

    const events: EventType[] = [];
    for await (const event of agent.run({ messages: [{ role: "user", content: "x" }] })) {
      events.push(event.type);
    }

    expect(events).toContain(EventType.TOOL_CALL_RESULT);
    expect(warnSpy).toHaveBeenCalledWith(
      "stateFromResult failed for Flaky",
      expect.any(Error)
    );
    expect(warnSpy).toHaveBeenCalledWith(
      "customResultHandler failed for Flaky",
      expect.any(Error)
    );
    warnSpy.mockRestore();
  });

  it("stringifies object tool inputs and falls back when argsStreamer missing", async () => {
    pushStreamFactory(() =>
      createStream([
        {
          current_tool_use: {
            name: "ObjTool",
            toolUseId: "t2",
            input: { foo: "bar" },
          },
        },
        { event: { contentBlockStop: {} } },
      ])
    );

    const agent = new StrandsAgent(
      { model: "mock" } as any,
      "Args Agent",
      "",
      {
        toolBehaviors: {
          ObjTool: {},
        },
      }
    );

    const events: EventType[] = [];
    for await (const event of agent.run({ messages: [{ role: "user", content: "call" }] })) {
      events.push(event.type);
    }

    const argsEventIndex = events.findIndex((t) => t === EventType.TOOL_CALL_ARGS);
    expect(argsEventIndex).toBeGreaterThan(-1);
  });

  it("uses the default empty stream when no factories are registered", async () => {
    // no pushStreamFactory call here exercises the default emptyStream
    const agent = new StrandsAgent(
      { model: "mock" } as any,
      "Default Stream Agent"
    );

    const events: EventType[] = [];
    for await (const event of agent.run({ messages: [{ role: "user", content: "hi" }] })) {
      events.push(event.type);
    }

    expect(events).toEqual([EventType.RUN_STARTED, EventType.RUN_FINISHED]);
  });

  it("sends the Hello fallback when no user text exists", async () => {
    let receivedInput: unknown;
    pushStreamFactory((input) => {
      receivedInput = input;
      return createStream([]);
    });

    const agent = new StrandsAgent(
      { model: "mock" } as any,
      "Hello Agent"
    );

    const events: EventType[] = [];
    for await (const event of agent.run({ messages: [] })) {
      events.push(event.type);
    }

    expect(receivedInput).toBe("Hello");
    expect(events).toEqual([EventType.RUN_STARTED, EventType.RUN_FINISHED]);
  });

  it("processes legacy tool results without prior tool call context", async () => {
    pushStreamFactory(() =>
      createStream([
        {
          message: {
            role: "user",
            content: [
              {
                toolResult: {
                  tool_use_id: "legacy-1",
                  content: [{ text: "{}" }],
                },
              },
            ],
          },
        },
      ])
    );

    const agent = new StrandsAgent(
      { model: "mock" } as any,
      "Legacy Result Agent"
    );

    const events: EventType[] = [];
    for await (const event of agent.run({ messages: [] })) {
      events.push(event.type);
    }

    expect(events).toEqual([
      EventType.RUN_STARTED,
      EventType.TOOL_CALL_RESULT,
      EventType.RUN_FINISHED,
    ]);
  });

  it("skips null argument chunks from argsStreamer", async () => {
    pushStreamFactory(() =>
      createStream([
        {
          current_tool_use: {
            name: "Argy",
            tool_use_id: "arg-1",
          },
        },
        { event: { contentBlockStop: {} } },
      ])
    );

    const agent = new StrandsAgent(
      { model: "mock" } as any,
      "Arg Stream Agent",
      "",
      {
        toolBehaviors: {
          Argy: {
            argsStreamer: async function* () {
              yield null;
              yield "{}";
            },
          },
        },
      }
    );

    const events: EventType[] = [];
    for await (const event of agent.run({ tools: [{ name: "Argy" }] })) {
      events.push(event.type);
    }

    expect(events).toContain(EventType.TOOL_CALL_ARGS);
  });

  it("emits RUN_ERROR with unknown error text when run throws a string", async () => {
    pushStreamFactory(() => {
      throw "fail"; // eslint-disable-line no-throw-literal
    });

    const agent = new StrandsAgent(
      { model: "mock" } as any,
      "Error Agent"
    );

    const events: EventType[] = [];
    for await (const event of agent.run({ messages: [{ role: "user", content: "x" }] })) {
      events.push(event.type);
    }

    expect(events.at(-1)).toBe(EventType.RUN_ERROR);
  });

  it("ignores non-array message content from Strands responses", async () => {
    pushStreamFactory(() =>
      createStream([
        {
          message: {
            role: "user",
            content: "plain string",
          },
        },
      ])
    );

    const agent = new StrandsAgent(
      { model: "mock" } as any,
      "Message Agent"
    );

    const events: EventType[] = [];
    for await (const event of agent.run({ messages: [{ role: "user", content: "hi" }] })) {
      events.push(event.type);
    }

    expect(events).toEqual([EventType.RUN_STARTED, EventType.RUN_FINISHED]);
  });

  it("generates random tool IDs for backend tools without provided ids", async () => {
    const ids: string[] = [];
    pushStreamFactory(() =>
      createStream([
        {
          current_tool_use: {
            name: "BackendNoId",
            input: "{}",
          },
        },
        { event: { contentBlockStop: {} } },
      ])
    );

    const agent = new StrandsAgent(
      { model: "mock" } as any,
      "Backend Agent"
    );

    for await (const event of agent.run({
      messages: [{ role: "user", content: "call" }],
    })) {
      if (event.type === EventType.TOOL_CALL_START) {
        ids.push(event.toolCallId);
      }
    }

    expect(ids).toHaveLength(1);
  });

  it("handles current tool uses with non-string names", async () => {
    pushStreamFactory(() =>
      createStream([
        {
          current_tool_use: {
            name: 123,
            tool_use_id: "num",
            input: "",
          },
        },
        { event: { contentBlockStop: {} } },
      ])
    );

    const agent = new StrandsAgent(
      { model: "mock" } as any,
      "NonString Tool Agent"
    );

    const events: EventType[] = [];
    for await (const event of agent.run({ messages: [{ role: "user", content: "x" }] })) {
      events.push(event.type);
    }

    expect(events).toEqual([EventType.RUN_STARTED, EventType.RUN_FINISHED]);
  });
});

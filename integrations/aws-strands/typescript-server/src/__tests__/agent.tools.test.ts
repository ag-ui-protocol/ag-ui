import {
  createStream,
  pushStreamFactory,
  resetStreamFactories,
  setupUuidMockSequence,
} from "./agent-mocks";
import { StrandsAgent } from "../agent";
import { PredictStateMapping, ToolResultContext } from "../config";
import {
  AguiEvent,
  CustomEvent,
  EventType,
  RunAgentInput,
  ToolCallArgsEvent,
} from "../types";

describe("StrandsAgent - tool behaviors", () => {
  beforeEach(() => {
    resetStreamFactories();
    setupUuidMockSequence();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("emits tool call lifecycle, predict state, and result events honoring tool behaviors", async () => {
    pushStreamFactory(() =>
      createStream([
        {
          current_tool_use: {
            name: "FetchWeather",
            toolUseId: "remote-1",
            input: '{"city":"Paris"}',
          },
        },
        { event: { contentBlockStop: {} } },
        {
          message: {
            role: "user",
            content: [
              {
                toolResult: {
                  toolUseId: "remote-1",
                  content: [{ text: "{'temp':20}" }],
                },
              },
            ],
          },
        },
        { delta: "ignored after result" },
      ])
    );

    const argsStreamer = jest.fn(async function* () {
      yield '{"city":"Paris"}';
    });
    const stateFromArgs = jest.fn().mockResolvedValue({ stage: "args" });
    const stateFromResult = jest.fn().mockResolvedValue({ stage: "result" });
    const customResultCalls: ToolResultContext[] = [];
    const customResultHandler = async function* (
      context: ToolResultContext
    ): AsyncGenerator<CustomEvent | null, void, unknown> {
      customResultCalls.push(context);
      yield null;
      yield {
        type: EventType.CUSTOM,
        name: "AfterTool",
        value: "extra",
      };
    };

    const agent = new StrandsAgent(
      { model: "mock-model" } as any,
      "Tool Agent",
      "",
      {
        toolBehaviors: {
          FetchWeather: {
            argsStreamer,
            stateFromArgs,
            stateFromResult,
            customResultHandler,
            stopStreamingAfterResult: true,
            predictState: [
              new PredictStateMapping({
                stateKey: "city",
                tool: "FetchWeather",
                toolArgument: "city",
              }),
            ],
          },
        },
      }
    );

    const events: AguiEvent[] = [];
    for await (const event of agent.run({
      thread_id: "thread-tool",
      run_id: "run-tool",
      messages: [{ role: "user", content: "Weather?" }],
    })) {
      events.push(event);
    }

    expect(stateFromArgs).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "FetchWeather" })
    );
    expect(stateFromResult).toHaveBeenCalledWith(
      expect.objectContaining({ resultData: { temp: 20 } })
    );
    expect(customResultCalls).toHaveLength(1);

    expect(events.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.STATE_SNAPSHOT,
      EventType.CUSTOM,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.TOOL_CALL_RESULT,
      EventType.STATE_SNAPSHOT,
      EventType.CUSTOM,
      EventType.RUN_FINISHED,
    ]);

    expect(events[2]).toMatchObject({
      type: EventType.CUSTOM,
      name: "PredictState",
      value: [
        {
          state_key: "city",
          tool: "FetchWeather",
          tool_argument: "city",
        },
      ],
    });
    expect(events[4]).toMatchObject({
      type: EventType.TOOL_CALL_ARGS,
      delta: '{"city":"Paris"}',
    });
    expect(events[6]).toMatchObject({
      type: EventType.TOOL_CALL_RESULT,
      content: '{"temp":20}',
    });
    expect(events[8]).toMatchObject({
      type: EventType.CUSTOM,
      name: "AfterTool",
      value: "extra",
    });
    expect(
      events.some((event) => event.type === EventType.TEXT_MESSAGE_CONTENT)
    ).toBe(false);
  });

  it("falls back to serialized args when argsStreamer throws", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    pushStreamFactory(() =>
      createStream([
        {
          current_tool_use: {
            name: "FrontendTool",
            toolUseId: "front-1",
            input: '{"info":"value"}',
          },
        },
        { event: { contentBlockStop: {} } },
      ])
    );

    const failingArgsStreamer = jest.fn(async function* () {
      throw new Error("args failure");
    });

    const agent = new StrandsAgent(
      { model: "mock" } as any,
      "Args Agent",
      "",
      {
        toolBehaviors: {
          FrontendTool: {
            argsStreamer: failingArgsStreamer,
          },
        },
      }
    );

    const events: AguiEvent[] = [];
    for await (const event of agent.run({
      tools: [{ name: "FrontendTool" }],
      messages: [{ role: "user", content: "call tool" }],
    })) {
      events.push(event);
    }

    const argsEvent = events.find(
      (event) => event.type === EventType.TOOL_CALL_ARGS
    ) as ToolCallArgsEvent;
    expect(argsEvent.delta).toBe('{"info":"value"}');
    expect(failingArgsStreamer).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("updates tool calls using Strands IDs and skips events when pending tool results exist", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);

    pushStreamFactory(() =>
      createStream([
        {
          current_tool_use: {
            name: "BackendTool",
            toolUseId: "remote-42",
            input: '{"foo":1}',
          },
        },
        {
          current_tool_use: {
            name: "BackendTool",
            toolUseId: "remote-42",
            input: "invalid json",
          },
        },
        { event: { contentBlockStop: {} } },
      ])
    );

    const agent = new StrandsAgent(
      {
        model: "mock",
        toolRegistry: { registry: new Map([["entry", { id: 1 }]]) },
      } as any,
      "Backend Agent",
      "",
      {
        toolBehaviors: {
          BackendTool: {
            stateFromArgs: () => {
              throw new Error("state args fail");
            },
          },
        },
      }
    );

    const events: AguiEvent[] = [];
    for await (const event of agent.run({
      tools: [{ tool_name: "BackendTool" }],
      messages: [
        { role: "user", content: "hello" },
        { role: "tool", content: '{"output":"done"}' },
      ],
    })) {
      events.push(event);
    }

    expect(
      events.some((event) => event.type === EventType.TOOL_CALL_START)
    ).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      "stateFromArgs failed for BackendTool",
      expect.any(Error)
    );
    warnSpy.mockRestore();
  });
});

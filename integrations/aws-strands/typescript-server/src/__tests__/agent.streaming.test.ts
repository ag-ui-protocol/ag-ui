import {
  createStream,
  pushLegacyStreamFactory,
  pushUnsupportedStream,
  resetStreamFactories,
  setupUuidMockSequence,
} from "./agent-mocks";
import { StrandsAgent } from "../agent";
import { EventType, AguiEvent } from "../types";

describe("StrandsAgent - streaming", () => {
  beforeEach(() => {
    resetStreamFactories();
    setupUuidMockSequence();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("uses legacy stream() implementation when streamAsync is unavailable", async () => {
    let receivedInput: string | undefined;
    pushLegacyStreamFactory((input) => {
      receivedInput = input as string;
      return createStream([{ data: "Legacy response" }]);
    });

    const agent = new StrandsAgent(
      { model: "legacy-model" } as any,
      "Legacy Agent"
    );

    const events: EventType[] = [];
    for await (const event of agent.run({
      thread_id: "t1",
      run_id: "r1",
      messages: [{ role: "user", content: "Hey" }],
    })) {
      events.push(event.type);
    }

    expect(receivedInput).toBe("Hey");
    expect(events).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED,
    ]);
  });

  it("emits RUN_ERROR when the Strands agent cannot stream", async () => {
    pushUnsupportedStream();

    const agent = new StrandsAgent(
      { model: "bad-agent" } as any,
      "Broken Agent"
    );

    const events: AguiEvent[] = [];
    for await (const event of agent.run({
      messages: [{ role: "user", content: "Ping" }],
    })) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.RUN_ERROR,
    ]);
    const errorEvent = events[1];
    expect(errorEvent).toMatchObject({
      type: EventType.RUN_ERROR,
      code: "STRANDS_ERROR",
    });
  });
});

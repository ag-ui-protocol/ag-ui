import {
  createStream,
  pushStreamFactory,
  resetStreamFactories,
  setupUuidMockSequence,
} from "./agent-mocks";
import type { ContentBlockData } from "@strands-agents/sdk";
import { StrandsAgent } from "../agent";
import { RunAgentInput, EventType, AguiEvent } from "../types";

describe("StrandsAgent - context and content", () => {
  beforeEach(() => {
    resetStreamFactories();
    setupUuidMockSequence();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("streams assistant text, snapshots state and rewrites user message via context builder", async () => {
    let receivedInput: string | ContentBlockData[] | undefined;
    pushStreamFactory((input) => {
      receivedInput = input;
      return createStream([{ delta: "Hello" }, { delta: [" ", "world"] }]);
    });

    const builder = jest
      .fn<Promise<string>, [RunAgentInput, string]>()
      .mockResolvedValue("Describe the weather + extra context");

    const agent = new StrandsAgent(
      { model: "mock-model", recordDirectToolCall: true } as any,
      "Test Agent",
      "",
      { stateContextBuilder: builder }
    );

    const input: RunAgentInput = {
      thread_id: "thread-123",
      run_id: "run-123",
      state: {
        foo: "bar",
        messages: [{ role: "assistant", content: "old" }],
      },
      messages: [
        { role: "system", content: "Rules" },
        { role: "user", content: "Describe the weather" },
      ],
    };

    const events: AguiEvent[] = [];
    for await (const event of agent.run(input)) {
      events.push(event);
    }

    expect(builder).toHaveBeenCalledWith(
      expect.objectContaining({ thread_id: "thread-123" }),
      "Describe the weather"
    );
    expect(receivedInput).toBe("Describe the weather + extra context");

    expect(events.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.STATE_SNAPSHOT,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED,
    ]);

    expect(events[1]).toMatchObject({
      type: EventType.STATE_SNAPSHOT,
      snapshot: { foo: "bar" },
    });
    expect(events[3]).toMatchObject({
      type: EventType.TEXT_MESSAGE_CONTENT,
      delta: "Hello",
    });
    expect(events[4]).toMatchObject({
      type: EventType.TEXT_MESSAGE_CONTENT,
      delta: " world",
    });
  });

  it("sends ContentBlockData when user messages include binary attachments", async () => {
    let receivedInput: string | ContentBlockData[] | undefined;
    pushStreamFactory((input) => {
      receivedInput = input;
      return createStream([]);
    });

    const imageBase64 = Buffer.from("image-binary").toString("base64");
    const pdfBase64 = Buffer.from("%PDF-1.7").toString("base64");

    const agent = new StrandsAgent(
      { model: "mock-model" } as any,
      "Attachments Agent"
    );

    const input: RunAgentInput = {
      thread_id: "thread-attachments",
      run_id: "run-attachments",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Check these files" },
            { type: "binary", mimeType: "image/png", data: imageBase64 },
            {
              type: "binary",
              mimeType: "application/pdf",
              data: pdfBase64,
              filename: "plan.pdf",
            },
          ],
        },
      ],
    };

    const events: AguiEvent[] = [];
    for await (const event of agent.run(input)) {
      events.push(event);
    }

    expect(Array.isArray(receivedInput)).toBe(true);
    const blocks = receivedInput as ContentBlockData[];
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toEqual({ text: "Check these files" });
    expect("image" in blocks[1]).toBe(true);
    expect("document" in blocks[2]).toBe(true);
    const imageBlock = (blocks[1] as { image: { format: string } }).image;
    expect(imageBlock.format).toBe("png");
    const documentBlock = (blocks[2] as {
      document: { name: string; format: string };
    }).document;
    expect(documentBlock.name).toBe("plan.pdf");
    expect(documentBlock.format).toBe("pdf");
  });

  it("keeps the original message when the state context builder throws", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);

    let receivedInput: string | ContentBlockData[] | undefined;
    pushStreamFactory((input) => {
      receivedInput = input;
      return createStream([{ delta: "ok" }]);
    });

    const builder = jest.fn(() => {
      throw new Error("context failure");
    });

    const agent = new StrandsAgent(
      { model: "mock" } as any,
      "Context Agent",
      "",
      { stateContextBuilder: builder }
    );

    const events: EventType[] = [];
    for await (const event of agent.run({
      messages: [{ role: "user", content: "Keep me" }],
    })) {
      events.push(event.type);
    }

    expect(receivedInput).toBe("Keep me");
    expect(builder).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      "State context builder failed",
      expect.any(Error)
    );
    warnSpy.mockRestore();
    expect(events).toContain(EventType.RUN_FINISHED);
  });
});

import { describe, expect, it, vi } from "vitest";
import { EventType, type RunAgentInput } from "@ag-ui/core";
import { LangGraphAgent } from "../agent";

const input: RunAgentInput = {
  threadId: "thread-error",
  runId: "run-error",
  state: {},
  tools: [],
  context: [],
  forwardedProps: {},
  messages: [
    {
      id: "video",
      role: "user",
      content: [
        {
          type: "video",
          source: { type: "data", value: "AAAA", mimeType: "video/mp4" },
        },
      ],
    },
  ],
};

function makeAgent(mode: "in-band" | "throw" | "prepare") {
  const agent = new LangGraphAgent({
    graphId: "test",
    deploymentUrl: "http://localhost:8000",
  });
  const failure = new Error(
    "Unsupported video format from provider translator",
  );
  const client = {
    assistants: {
      search: vi
        .fn()
        .mockResolvedValue([
          { assistant_id: "asst", graph_id: "test", config: {} },
        ]),
      getGraph: vi.fn().mockResolvedValue({ nodes: [], edges: [] }),
      getSchemas: vi.fn().mockResolvedValue({
        input_schema: { properties: { messages: {} } },
        output_schema: { properties: { messages: {} } },
      }),
    },
    threads: {
      get: vi.fn().mockResolvedValue({ thread_id: input.threadId }),
      getState: vi.fn().mockResolvedValue({
        values: { messages: [] },
        next: [],
        tasks: [],
        metadata: {},
      }),
    },
    runs: {
      stream: vi.fn().mockImplementation(async function* () {
        if (mode === "throw") throw failure;
        yield {
          event: "error",
          data: { message: failure.message, error: "ValueError" },
        };
      }),
    },
  };
  if (mode === "prepare") client.assistants.search.mockRejectedValue(failure);
  Object.assign(agent, { client });
  return { agent, client };
}

async function collect(agent: LangGraphAgent) {
  const events: { type: string; message?: string }[] = [];
  await new Promise<void>((resolve, reject) =>
    agent.run(input).subscribe({
      next: (event) => events.push(event),
      error: reject,
      complete: resolve,
    }),
  );
  return events;
}

describe("public run error lifecycle", () => {
  it("does not emit errors after the caller unsubscribes", async () => {
    const { agent } = makeAgent("throw");
    let rejectPreparation!: (error: Error) => void;
    const preparation = new Promise<never>((_resolve, reject) => {
      rejectPreparation = reject;
    });
    vi.spyOn(agent, "getAssistant").mockReturnValue(preparation);
    const observer = { next: vi.fn(), error: vi.fn(), complete: vi.fn() };
    const subscription = agent.run(input).subscribe(observer);
    subscription.unsubscribe();
    rejectPreparation(new Error("cancelled preparation"));
    await preparation.catch(() => {});
    await Promise.resolve();
    expect(observer.next).not.toHaveBeenCalled();
    expect(observer.error).not.toHaveBeenCalled();
    expect(observer.complete).not.toHaveBeenCalled();
  });
  it.each(["in-band", "throw", "prepare"] as const)(
    "ends with exactly one RUN_ERROR for %s failure",
    async (mode) => {
      const { agent, client } = makeAgent(mode);
      const events = await collect(agent);
      if (mode !== "prepare") {
        expect(client.runs.stream).toHaveBeenCalledWith(
          input.threadId,
          "asst",
          expect.objectContaining({
            input: expect.objectContaining({
              messages: [
                expect.objectContaining({
                  content: [
                    {
                      type: "video",
                      source_type: "base64",
                      data: "AAAA",
                      mime_type: "video/mp4",
                    },
                  ],
                }),
              ],
            }),
          }),
        );
      }
      expect(events[0].type).toBe(EventType.RUN_STARTED);
      expect(
        events
          .filter(
            (e) =>
              e.type === EventType.RUN_ERROR ||
              e.type === EventType.RUN_FINISHED,
          )
          .map((e) => e.type),
      ).toEqual([EventType.RUN_ERROR]);
      expect(events.at(-1)?.type).toBe(EventType.RUN_ERROR);
      expect(events.at(-1)?.message).toContain(
        "Unsupported video format from provider translator",
      );
    },
  );
});

import { describe, expect, it } from "vitest";
import { firstValueFrom, toArray } from "rxjs";
import { EventType, type BaseEvent, type RunAgentInput } from "@ag-ui/client";
import { VercelAISDKAgent } from "../vercel-ai-sdk";
import {
  makeInput,
  makeMockModel,
  streamStart,
  responseMetadata,
  finishStop,
} from "./helpers";

function collect(agent: VercelAISDKAgent, input: RunAgentInput): Promise<BaseEvent[]> {
  return firstValueFrom(agent.run(input).pipe(toArray()));
}

describe("VercelAISDKAgent", () => {
  it("constructs with defaults (maxSteps=1, toolChoice=auto)", () => {
    const agent = new VercelAISDKAgent({ model: makeMockModel([]) });
    expect(agent.maxSteps).toBe(1);
    expect(agent.toolChoice).toBe("auto");
  });

  it("accepts custom maxSteps and toolChoice", () => {
    const agent = new VercelAISDKAgent({
      model: makeMockModel([]),
      maxSteps: 5,
      toolChoice: "none",
    });
    expect(agent.maxSteps).toBe(5);
    expect(agent.toolChoice).toBe("none");
  });

  it("clones with the same config", () => {
    const model = makeMockModel([]);
    const agent = new VercelAISDKAgent({ model, maxSteps: 3, toolChoice: "required" });
    const clone = agent.clone();
    expect(clone).not.toBe(agent);
    expect(clone.maxSteps).toBe(3);
    expect(clone.toolChoice).toBe("required");
    expect(clone.model).toBe(model);
  });

  it("runs end-to-end: emits RUN_STARTED, text events, RUN_FINISHED", async () => {
    const model = makeMockModel([
      streamStart,
      responseMetadata(),
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "Hello" },
      { type: "text-end", id: "t1" },
      finishStop(),
    ]);
    const agent = new VercelAISDKAgent({ model });
    const events = await collect(
      agent,
      makeInput({ messages: [{ id: "u", role: "user", content: "Hi" }] }),
    );

    const types = events.map((e) => e.type);
    expect(types[0]).toBe(EventType.RUN_STARTED);
    expect(types[types.length - 1]).toBe(EventType.RUN_FINISHED);
    expect(types).toContain(EventType.TEXT_MESSAGE_START);
    expect(types).toContain(EventType.TEXT_MESSAGE_CONTENT);
    expect(types).toContain(EventType.TEXT_MESSAGE_END);
    expect(types).toContain(EventType.MESSAGES_SNAPSHOT);
  });

  it("propagates abort on unsubscribe — does not emit RUN_ERROR to the consumer", async () => {
    // Custom delayed stream so the consumer can unsubscribe mid-stream.
    const { MockLanguageModelV3 } = await import("ai/test");
    const model = new MockLanguageModelV3({
      doStream: async () =>
        ({
          stream: new ReadableStream({
            async start(controller) {
              controller.enqueue(streamStart);
              controller.enqueue(responseMetadata());
              controller.enqueue({ type: "text-start", id: "t1" });
              controller.enqueue({ type: "text-delta", id: "t1", delta: "Partial" });
              await new Promise((r) => setTimeout(r, 200));
              controller.enqueue({ type: "text-end", id: "t1" });
              controller.enqueue(finishStop());
              controller.close();
            },
          }),
        }) as never,
    });
    const agent = new VercelAISDKAgent({ model });

    const events: BaseEvent[] = [];
    await new Promise<void>((resolve) => {
      const sub = agent
        .run(makeInput({ messages: [{ id: "u", role: "user", content: "Hi" }] }))
        .subscribe({
          next: (e) => {
            events.push(e);
            if (e.type === EventType.TEXT_MESSAGE_CONTENT) {
              setTimeout(() => sub.unsubscribe(), 0);
            }
          },
          complete: () => resolve(),
          error: () => resolve(),
        });
      setTimeout(resolve, 1000);
    });

    const errs = events.filter((e) => e.type === EventType.RUN_ERROR);
    expect(errs.length).toBe(0);
  });
});

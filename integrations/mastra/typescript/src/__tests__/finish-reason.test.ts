import { describe, expect, it } from "vitest";
import { EventType } from "@ag-ui/client";
import {
  collectEvents,
  makeInput,
  makeLocalMastraAgent,
  makeRemoteMastraAgent,
} from "./helpers";

const finishChunk = { type: "finish", payload: {} };

function runFinished(events: any[]) {
  return events.find((e) => e.type === EventType.RUN_FINISHED) as any;
}

// Without the finish reason, a turn cut off by the step limit (`tool-calls`)
// or the length limit (`length`) ends in a RUN_FINISHED identical to a
// finished answer, so no client can say why the answer stopped.
describe("MastraAgent — RUN_FINISHED finish reason", () => {
  it.each(["stop", "length", "tool-calls"])(
    "surfaces a local run's finish reason %s on metadata.mastra",
    async (reason) => {
      const agent = makeLocalMastraAgent({
        streamChunks: [finishChunk],
        finishReason: Promise.resolve(reason),
      });
      const finished = runFinished(await collectEvents(agent, makeInput()));
      expect(finished.metadata).toEqual({ mastra: { finishReason: reason } });
    },
  );

  it("omits metadata when the response reports no finish reason", async () => {
    const agent = makeLocalMastraAgent({ streamChunks: [finishChunk] });
    const finished = runFinished(await collectEvents(agent, makeInput()));
    expect(finished).toBeDefined();
    expect(finished.metadata).toBeUndefined();
  });

  it("still finishes the run when the finish reason rejects", async () => {
    const rejected = Promise.reject(new Error("no reason"));
    rejected.catch(() => {});
    const agent = makeLocalMastraAgent({
      streamChunks: [finishChunk],
      finishReason: rejected,
    });
    const finished = runFinished(await collectEvents(agent, makeInput()));
    expect(finished).toBeDefined();
    expect(finished.metadata).toBeUndefined();
  });

  it("keeps the finish reason beside usage", async () => {
    const agent = makeLocalMastraAgent({
      streamChunks: [finishChunk],
      usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
      finishReason: "length",
    });
    const finished = runFinished(await collectEvents(agent, makeInput()));
    expect(finished.usage?.[0]).toMatchObject({ totalTokens: 7 });
    expect(finished.metadata).toEqual({ mastra: { finishReason: "length" } });
  });

  it("reports the finish reason from a remote stream's finish chunk", async () => {
    const agent = makeRemoteMastraAgent({
      streamChunks: [
        {
          type: "step-finish",
          payload: { stepResult: { reason: "tool-calls" } },
        },
        { type: "finish", payload: { stepResult: { reason: "length" } } },
      ],
    });
    const finished = runFinished(await collectEvents(agent, makeInput()));
    expect(finished.metadata).toEqual({ mastra: { finishReason: "length" } });
  });
});

describe("MastraAgent — RUN_FINISHED finish reason on resumed runs", () => {
  const resumeInterrupt = {
    type: "mastra_suspend",
    toolCallId: "tc-1",
    runId: "run-1",
  };

  function makeResumeInput(interruptEvent: Record<string, any>) {
    return makeInput({
      forwardedProps: {
        command: {
          resume: { approved: true },
          interruptEvent: JSON.stringify(interruptEvent),
        },
      },
    });
  }

  it("reports the finish reason on the local resume path", async () => {
    const agent = makeLocalMastraAgent({
      streamChunks: [],
      resumeChunks: [{ type: "text-delta", payload: { text: "Approved." } }],
      finishReason: "stop",
    });
    const finished = runFinished(
      await collectEvents(agent, makeResumeInput(resumeInterrupt)),
    );
    expect(finished.metadata).toEqual({ mastra: { finishReason: "stop" } });
  });

  it("reports the finish reason from a remote resumed stream", async () => {
    const agent = makeRemoteMastraAgent({
      resumeChunks: [
        { type: "finish", payload: { stepResult: { reason: "tool-calls" } } },
      ],
    });
    const finished = runFinished(
      await collectEvents(agent, makeResumeInput(resumeInterrupt)),
    );
    expect(finished.metadata).toEqual({
      mastra: { finishReason: "tool-calls" },
    });
  });
});

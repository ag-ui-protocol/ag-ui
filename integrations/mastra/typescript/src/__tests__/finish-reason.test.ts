import { describe, expect, it } from "vitest";
import { EventType } from "@ag-ui/client";
import { RunFinishedEventSchema } from "@ag-ui/core/schemas";
import {
  collectEvents,
  makeInput,
  makeLocalMastraAgent,
  makeRemoteMastraAgent,
} from "./helpers";

const finishChunk = { type: "finish", payload: {} };
const text = { type: "text-delta", payload: { text: "partial" } };
// Shape emitted by @mastra/core when a run is cancelled.
const mastraAbort = { type: "abort", runId: "r1", from: "AGENT", payload: {} };

/** A remote stream's terminal `finish` chunk reporting `reason`. */
function remoteFinish(reason: string) {
  return { type: "finish", payload: { stepResult: { reason } } };
}

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
      expect(() => RunFinishedEventSchema.parse(finished)).not.toThrow();
    },
  );

  it("omits metadata when the response reports no finish reason", async () => {
    const agent = makeLocalMastraAgent({ streamChunks: [finishChunk] });
    const finished = runFinished(await collectEvents(agent, makeInput()));
    expect(finished).toBeDefined();
    expect("metadata" in finished).toBe(false);
  });

  it("omits metadata when the finish reason resolves to undefined", async () => {
    const agent = makeLocalMastraAgent({
      streamChunks: [finishChunk],
      finishReason: Promise.resolve(undefined),
    });
    const finished = runFinished(await collectEvents(agent, makeInput()));
    expect(finished).toBeDefined();
    expect("metadata" in finished).toBe(false);
  });

  it("still finishes the run when the finish reason rejects", async () => {
    const rejected = Promise.reject(new Error("no reason"));
    rejected.catch(() => {});
    const agent = makeLocalMastraAgent({
      streamChunks: [finishChunk],
      finishReason: rejected,
    });
    const events = await collectEvents(agent, makeInput());
    const finished = runFinished(events);
    expect(finished).toBeDefined();
    expect("metadata" in finished).toBe(false);
    expect(events.some((e) => e.type === EventType.RUN_ERROR)).toBe(false);
  });

  it("keeps the finish reason beside usage", async () => {
    const agent = makeLocalMastraAgent({
      streamChunks: [finishChunk],
      usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
      finishReason: Promise.resolve("length"),
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
        remoteFinish("length"),
      ],
    });
    const finished = runFinished(await collectEvents(agent, makeInput()));
    expect(finished.metadata).toEqual({ mastra: { finishReason: "length" } });
    expect(() => RunFinishedEventSchema.parse(finished)).not.toThrow();
  });
});

describe("MastraAgent — RUN_FINISHED finish reason on resumed runs", () => {
  const resumeInterrupt = { toolCallId: "tc-1", runId: "run-1" };

  function makeResumeInput(suspended: { toolCallId: string; runId: string }) {
    return makeInput({
      resume: [
        {
          interruptId: `${suspended.runId}::${suspended.toolCallId}`,
          status: "resolved",
          payload: { approved: true },
        },
      ],
    });
  }

  it("reports the finish reason on the local resume path", async () => {
    const agent = makeLocalMastraAgent({
      streamChunks: [],
      resumeChunks: [{ type: "text-delta", payload: { text: "Approved." } }],
      finishReason: Promise.resolve("stop"),
    });
    const finished = runFinished(
      await collectEvents(agent, makeResumeInput(resumeInterrupt)),
    );
    expect(finished.metadata).toEqual({ mastra: { finishReason: "stop" } });
  });

  it("reports the finish reason from a remote resumed stream", async () => {
    const agent = makeRemoteMastraAgent({
      resumeChunks: [remoteFinish("tool-calls")],
    });
    const finished = runFinished(
      await collectEvents(agent, makeResumeInput(resumeInterrupt)),
    );
    expect(finished.metadata).toEqual({
      mastra: { finishReason: "tool-calls" },
    });
  });
});

// A cancelled run has no return value (docs/spec/1.0/events/lifecycle.mdx,
// "Cancelled runs"), so it carries no finish reason, the same rule as the
// traceId. Each case first runs the same stream to completion, which reports
// the reason, so it is the stop that withholds it.
describe("MastraAgent — a cancelled run carries no finish reason", () => {
  const resumeInput = makeInput({
    resume: [
      {
        interruptId: "run-1::tc-1",
        status: "resolved",
        payload: { approved: true },
      },
    ],
  });

  const cases = [
    [
      "local run",
      (tail: any[]) =>
        makeLocalMastraAgent({
          streamChunks: [text, ...tail],
          finishReason: Promise.resolve("tool-calls"),
        }),
      [finishChunk],
      makeInput(),
    ],
    [
      "remote run",
      (tail: any[]) =>
        makeRemoteMastraAgent({
          streamChunks: [text, remoteFinish("tool-calls"), ...tail],
        }),
      [],
      makeInput(),
    ],
    [
      "local resumed run",
      (tail: any[]) =>
        makeLocalMastraAgent({
          resumeChunks: [text, ...tail],
          finishReason: Promise.resolve("tool-calls"),
        }),
      [],
      resumeInput,
    ],
    [
      "remote resumed run",
      (tail: any[]) =>
        makeRemoteMastraAgent({
          resumeChunks: [text, remoteFinish("tool-calls"), ...tail],
        }),
      [],
      resumeInput,
    ],
  ] as const;

  it.each(cases)(
    "a %s stopped by Mastra's abort chunk reports no finish reason",
    async (_kind, makeAgent, completedTail, input) => {
      const completed = runFinished(
        await collectEvents(makeAgent([...completedTail]), input),
      );
      expect(completed.outcome).toBeUndefined();
      expect(completed.metadata).toEqual({
        mastra: { finishReason: "tool-calls" },
      });

      const stopped = runFinished(
        await collectEvents(makeAgent([mastraAbort]), input),
      );
      expect(stopped.outcome).toEqual({ type: "cancelled" });
      expect("metadata" in stopped).toBe(false);
      expect("result" in stopped).toBe(false);
      expect(() => RunFinishedEventSchema.parse(stopped)).not.toThrow();
    },
  );
});

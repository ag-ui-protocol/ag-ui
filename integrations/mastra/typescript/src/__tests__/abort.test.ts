import { describe, expect, it } from "vitest";
import { MastraAgent } from "../mastra";
import { FakeLocalAgent, makeInput } from "./helpers";

describe("abortRun()", () => {
  it("aborts the per-run signal passed to a local Mastra agent stream", async () => {
    const fakeAgent = new FakeLocalAgent();
    let capturedSignal: AbortSignal | undefined;
    let resolveStreamStarted!: () => void;
    let resolveStream!: () => void;
    const streamStarted = new Promise<void>((resolve) => {
      resolveStreamStarted = resolve;
    });
    const releaseStream = new Promise<void>((resolve) => {
      resolveStream = resolve;
    });

    fakeAgent.stream = async (_messages: any, opts?: any) => {
      capturedSignal = opts?.abortSignal;
      resolveStreamStarted();
      return {
        fullStream: (async function* () {
          await releaseStream;
          yield { type: "finish", payload: {} };
        })(),
      };
    };

    const agent = new MastraAgent({
      agentId: "test-agent",
      agent: fakeAgent as any,
      resourceId: "resource-1",
    });

    const runFinished = new Promise<void>((resolve, reject) => {
      agent.run(makeInput()).subscribe({
        error: reject,
        complete: resolve,
      });
    });

    await streamStarted;
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    expect(capturedSignal?.aborted).toBe(false);

    agent.abortRun();

    expect(capturedSignal?.aborted).toBe(true);
    resolveStream();
    await runFinished;
  });
});

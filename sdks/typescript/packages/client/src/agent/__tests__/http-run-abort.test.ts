import { HttpAgent } from "../http";
import { describe, it, expect } from "vitest";

const createAgent = () => {
  const signals: AbortSignal[] = [];
  const agent = new HttpAgent({
    url: "https://api.example.com/agent",
    fetch: (_url, init) => {
      const signal = init.signal!;
      signals.push(signal);
      return new Promise<Response>((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  });
  return { agent, signals };
};

describe("HttpAgent run abort", () => {
  it("aborts a superseded run's request that is built after the next run starts", async () => {
    const { agent, signals } = createAgent();

    const first = agent.runAgent().catch(() => undefined);
    agent.abortRun();
    const second = agent.runAgent().catch(() => undefined);

    await expect.poll(() => signals.length).toBe(2);
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(false);

    agent.abortRun();
    await Promise.all([first, second]);
    expect(signals[1]!.aborted).toBe(true);
  });

  it("binds each request to the controller passed for its run", async () => {
    const { agent, signals } = createAgent();
    const firstController = new AbortController();
    const secondController = new AbortController();

    const first = agent.runAgent({ abortController: firstController }).catch(() => undefined);
    const second = agent.runAgent({ abortController: secondController }).catch(() => undefined);

    await expect.poll(() => signals.length).toBe(2);
    firstController.abort();
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(false);

    secondController.abort();
    await Promise.all([first, second]);
  });

  it("binds a clone's requests to its own runs", async () => {
    const { agent, signals } = createAgent();
    const clone = agent.clone();

    const run = clone.runAgent().catch(() => undefined);
    await expect.poll(() => signals.length).toBe(1);
    expect(signals[0]!.aborted).toBe(false);

    clone.abortRun();
    await run;
    expect(signals[0]!.aborted).toBe(true);
  });
});

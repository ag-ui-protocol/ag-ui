import { describe, expect, it } from "vitest";
import { makeLocalMastraAgent } from "./helpers";

describe("MastraAgent.clone()", () => {
  it("runs a middleware registered with use() on the clone as well", async () => {
    const agent = makeLocalMastraAgent();
    const seen: string[] = [];
    agent.use((input, next) => {
      seen.push(input.runId);
      return next.run(input);
    });

    const cloned = agent.clone();

    await agent.runAgent({ runId: "run-original" });
    await cloned.runAgent({ runId: "run-clone" });

    expect(seen).toEqual(["run-original", "run-clone"]);
  });

  it("keeps the clone's middlewares independent of the original's", async () => {
    const agent = makeLocalMastraAgent();
    const seen: string[] = [];
    agent.use((input, next) => {
      seen.push(`first:${input.runId}`);
      return next.run(input);
    });
    const cloned = agent.clone();
    cloned.use((input, next) => {
      seen.push(`second:${input.runId}`);
      return next.run(input);
    });

    await agent.runAgent({ runId: "run-original" });
    await cloned.runAgent({ runId: "run-clone" });

    expect(seen).toEqual([
      "first:run-original",
      "first:run-clone",
      "second:run-clone",
    ]);
  });
});

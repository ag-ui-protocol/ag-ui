import { describe, expect, it, vi } from "vitest";
import type { BaseEvent } from "@ag-ui/core";
import { CopilotAgent } from "../src/index.js";
import { FakeClient, makeInput, run } from "./helpers.js";

describe("TypeScript/Python adapter parity", () => {
  it("P4: agent.interrupted terminates promptly with the Python interruption error", async () => {
    vi.useFakeTimers();
    const client = new FakeClient([{ id: "interrupted", type: "agent.interrupted", data: {} }]);
    const agent = new CopilotAgent({ client, runTimeoutMs: 200 });
    let terminal: BaseEvent | undefined;
    const completion = run(agent, makeInput()).then((events) => {
      terminal = events.at(-1);
      return events;
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect.soft(terminal).toMatchObject({ type: "RUN_ERROR", message: "Run was interrupted" });
      await vi.advanceTimersByTimeAsync(200);
      expect((await completion).at(-1)).toMatchObject({
        type: "RUN_ERROR", message: "Run was interrupted", code: "COPILOT_SDK_ERROR",
      });
      expect(client.session!.aborted).toBe(true);
      expect(client.session!.disconnected).toBe(true);
    } finally {
      await vi.runAllTimersAsync();
      await completion;
      await agent.close();
      vi.useRealTimers();
    }
  });

  it("P5: supplies the Python fallback when session.error has no message", async () => {
    const client = new FakeClient([{ id: "error", type: "session.error", data: {} }]);
    const agent = new CopilotAgent({ client, runTimeoutMs: 200 });
    try {
      expect((await run(agent, makeInput())).at(-1)).toEqual({
        type: "RUN_ERROR", message: "SDK session failed", code: "COPILOT_SDK_ERROR",
      });
    } finally {
      await agent.close();
    }
  });
});

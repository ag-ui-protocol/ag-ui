import { describe, expect, it } from "vitest";
import { of, lastValueFrom } from "rxjs";
import { AbstractAgent } from "../agent";
import type { BaseEvent, RunAgentInput } from "@ag-ui/core";
import { AGUIError, EventType } from "@ag-ui/core";

class StubAgent extends AbstractAgent {
  public received?: RunAgentInput;
  protected run(input: RunAgentInput) {
    this.received = input;
    return of<BaseEvent>(
      { type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId } as BaseEvent,
      { type: EventType.RUN_FINISHED, threadId: input.threadId, runId: input.runId, outcome: "success" } as BaseEvent,
    );
  }
}

describe("AbstractAgent — interrupt lifecycle enforcement", () => {
  it("allows runAgent() when pendingInterrupts is empty", async () => {
    const agent = new StubAgent();
    await expect(agent.runAgent()).resolves.toBeDefined();
  });

  it("allows runAgent() when resume covers every pending interrupt", async () => {
    const agent = new StubAgent();
    agent.pendingInterrupts = [
      { id: "int-1", reason: "tool_call" },
      { id: "int-2", reason: "tool_call" },
    ];
    await expect(
      agent.runAgent({
        resume: [
          { interruptId: "int-1", status: "resolved", payload: { approved: true } },
          { interruptId: "int-2", status: "cancelled" },
        ],
      }),
    ).resolves.toBeDefined();
  });

  it("throws AGUIError when pending interrupts exist but resume is missing", async () => {
    const agent = new StubAgent();
    agent.pendingInterrupts = [{ id: "int-1", reason: "tool_call" }];
    await expect(agent.runAgent()).rejects.toThrow(/pending interrupt/i);
  });

  it("throws AGUIError when resume does not cover every pending interrupt", async () => {
    const agent = new StubAgent();
    agent.pendingInterrupts = [
      { id: "int-1", reason: "tool_call" },
      { id: "int-2", reason: "tool_call" },
    ];
    await expect(
      agent.runAgent({
        resume: [{ interruptId: "int-1", status: "resolved" }],
      }),
    ).rejects.toThrow(/int-2/);
  });

  it("throws AGUIError when a pending interrupt is past expiresAt", async () => {
    const agent = new StubAgent();
    agent.pendingInterrupts = [
      { id: "int-1", reason: "tool_call", expiresAt: "2000-01-01T00:00:00Z" },
    ];
    await expect(
      agent.runAgent({ resume: [{ interruptId: "int-1", status: "resolved" }] }),
    ).rejects.toThrow(/expired/i);
  });
});

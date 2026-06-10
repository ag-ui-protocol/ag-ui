import { describe, it, expect } from "vitest";
import { EventType, type BaseEvent, type RunAgentInput } from "@ag-ui/core";

import { StrandsAgent } from "../agent";
import { collect, minimalRunInput, scriptedAgent } from "./helpers";

/**
 * Interrupt-rule-4 gate lives in `StrandsAgent.run()` above `_runRaw` so any
 * subclass that overrides only `_runRaw` still inherits the check and Strands
 * isn't spun up for a doomed request. These tests exercise the gate at the
 * agent layer directly (no HTTP) to pin its semantics.
 */
class NeverRanAgent extends StrandsAgent {
  public rawCalled = 0;

  constructor() {
    super({ agent: scriptedAgent(), name: "never" });
  }

  protected async *_runRaw(
    input: RunAgentInput,
  ): AsyncGenerator<BaseEvent, void, void> {
    this.rawCalled += 1;
    yield {
      type: EventType.RUN_STARTED,
      threadId: input.threadId,
      runId: input.runId,
    };
    yield {
      type: EventType.RUN_FINISHED,
      threadId: input.threadId,
      runId: input.runId,
    };
  }
}

describe("StrandsAgent resume[] gate (interrupts.mdx rule 4)", () => {
  it("emits RUN_STARTED then RUN_ERROR and never touches _runRaw", async () => {
    const agent = new NeverRanAgent();
    const events = await collect(
      agent,
      minimalRunInput({
        threadId: "t",
        runId: "r",
        resume: [
          { interruptId: "unknown-id", status: "resolved", payload: {} },
        ],
      }),
    );
    expect(agent.rawCalled).toBe(0);
    expect(events.map((e) => e.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.RUN_ERROR,
    ]);
    const [started, err] = events as unknown as [
      { threadId: string; runId: string },
      { code: string; message: string },
    ];
    expect(started.threadId).toBe("t");
    expect(started.runId).toBe("r");
    expect(err.code).toBe("UNKNOWN_INTERRUPT");
    expect(err.message).toMatch(/unknown-id/);
  });

  it("echoes up to four unknown interruptIds into the error message", async () => {
    const agent = new NeverRanAgent();
    const resume = Array.from({ length: 6 }, (_, i) => ({
      interruptId: `i-${i}`,
      status: "resolved" as const,
      payload: {},
    }));
    const events = await collect(agent, minimalRunInput({ resume }));
    const err = events.find(
      (e) => e.type === EventType.RUN_ERROR,
    ) as unknown as {
      message: string;
    };
    expect(err.message).toContain("i-0");
    expect(err.message).toContain("i-3");
    // Only the first 4 are quoted; i-4 and i-5 are elided to keep the message
    // from unbounded growth.
    expect(err.message).not.toContain("i-4");
    expect(err.message).not.toContain("i-5");
  });

  it("passes empty resume[] through to _runRaw (not a resume request)", async () => {
    const agent = new NeverRanAgent();
    const events = await collect(agent, minimalRunInput({ resume: [] }));
    expect(agent.rawCalled).toBe(1);
    expect(events.map((e) => e.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.RUN_FINISHED,
    ]);
  });

  it("passes missing resume through to _runRaw", async () => {
    const agent = new NeverRanAgent();
    const events = await collect(agent, minimalRunInput());
    expect(agent.rawCalled).toBe(1);
    expect(events.map((e) => e.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.RUN_FINISHED,
    ]);
  });

  it("clears stale pending interrupt IDs when a non-resume run starts", async () => {
    // Reproduces H1: a thread with an outstanding interrupt that the client
    // abandons (sends a fresh prompt instead of resume[]) must not leave the
    // old interruptIds in `_pendingInterruptsByThread`. Otherwise a later
    // replayed/raced resume[] could be accepted as valid against dead IDs.
    const agent = new NeverRanAgent();
    const pending = (
      agent as unknown as {
        _pendingInterruptsByThread: Map<string, Set<string>>;
      }
    )._pendingInterruptsByThread;
    pending.set("t", new Set(["stale-1", "stale-2"]));

    // Plain (non-resume) run on the same thread — the run itself should
    // succeed AND the stale IDs should be wiped.
    const events = await collect(
      agent,
      minimalRunInput({ threadId: "t", runId: "r1" }),
    );
    expect(events.map((e) => e.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.RUN_FINISHED,
    ]);
    expect(pending.has("t")).toBe(false);

    // A subsequent resume[] referencing the now-stale ID must be rejected.
    const rejected = await collect(
      agent,
      minimalRunInput({
        threadId: "t",
        runId: "r2",
        resume: [{ interruptId: "stale-1", status: "resolved", payload: {} }],
      }),
    );
    expect(rejected.map((e) => e.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.RUN_ERROR,
    ]);
    const err = rejected[1] as unknown as { code: string };
    expect(err.code).toBe("UNKNOWN_INTERRUPT");
  });

  it("does not clear pending interrupts when the run IS a resume", async () => {
    // Resume path manages cleanup itself (delete after building
    // InterruptResponseContent[] in `_runSingleAgent`). The gate must NOT
    // wipe pending IDs on the resume path or the resume itself would fail.
    const agent = new NeverRanAgent();
    const pending = (
      agent as unknown as {
        _pendingInterruptsByThread: Map<string, Set<string>>;
      }
    )._pendingInterruptsByThread;
    pending.set("t", new Set(["live-1"]));

    // Valid resume entry passes the gate, then NeverRanAgent's stub _runRaw
    // returns without touching the map. Verify the gate itself does not
    // delete the pending set.
    await collect(
      agent,
      minimalRunInput({
        threadId: "t",
        runId: "r1",
        resume: [{ interruptId: "live-1", status: "resolved", payload: {} }],
      }),
    );
    expect(pending.get("t")?.has("live-1")).toBe(true);
  });
});

import { Observable, of, Subscriber } from "rxjs";
import { AbstractAgent } from "@/agent";
import {
  BaseEvent,
  EventType,
  MessagesSnapshotEvent,
  RunAgentInput,
  RunFinishedEvent,
  RunStartedEvent,
  TextMessageStartEvent,
} from "@ag-ui/core";

/** Emits RUN_STARTED and stays open until detached. */
class HangingAgent extends AbstractAgent {
  public open: Array<Subscriber<BaseEvent>> = [];
  public teardowns = 0;

  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      this.open.push(subscriber);
      const started: RunStartedEvent = {
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      };
      subscriber.next(started);
      return () => {
        this.teardowns += 1;
      };
    });
  }

  protected connect(input: RunAgentInput): Observable<BaseEvent> {
    return this.run(input);
  }
}

class StartupFailureAgent extends AbstractAgent {
  private attempts = 0;

  run(input: RunAgentInput): Observable<BaseEvent> {
    if (++this.attempts === 1) throw new Error("startup failed");
    const started: RunStartedEvent = {
      type: EventType.RUN_STARTED,
      threadId: input.threadId,
      runId: input.runId,
    };
    const finished: RunFinishedEvent = {
      type: EventType.RUN_FINISHED,
      threadId: input.threadId,
      runId: input.runId,
    };
    return of(started, finished);
  }
}

async function waitForRuns(agent: HangingAgent, count: number): Promise<void> {
  await vi.waitFor(() => expect(agent.open).toHaveLength(count));
}

describe("single-run detachment", () => {
  it.each(["runAgent", "connectAgent"] as const)(
    "detaches %s before reusing the agent and ignores the old stream",
    async (method) => {
      const agent = new HangingAgent({ debug: false });
      const onRunFinalized = vi.fn();
      const first = agent[method]({ runId: "detach-first" }, { onRunFinalized });
      await waitForRuns(agent, 1);

      await agent.detachActiveRun();
      await first;

      expect(agent.teardowns).toBe(1);
      expect(agent.isRunning).toBe(false);
      expect(onRunFinalized).toHaveBeenCalledTimes(1);

      const second = agent[method]({ runId: "detach-second" });
      await waitForRuns(agent, 2);
      const staleSnapshot: MessagesSnapshotEvent = {
        type: EventType.MESSAGES_SNAPSHOT,
        messages: [{ id: "stale", role: "assistant", content: "Must be ignored" }],
      };
      agent.open[0].next(staleSnapshot);
      expect(agent.messages).toEqual([]);
      expect(agent.isRunning).toBe(true);

      await agent.detachActiveRun();
      await second;
      expect(agent.teardowns).toBe(2);
      expect(agent.isRunning).toBe(false);
    },
  );

  it("ignores events and a stream error sent after detaching, even with slow subscribers", async () => {
    const agent = new HangingAgent({ debug: false });
    const seen: string[] = [];
    const onRunFailed = vi.fn();
    const onRunFinalized = vi.fn();
    let releaseFirst: (() => void) | undefined;
    const run = agent.runAgent(
      { runId: "detach-slow" },
      {
        onEvent: async ({ event }) => {
          if (seen.length === 0) {
            await new Promise<void>((resolve) => (releaseFirst = resolve));
          }
          seen.push(event.type);
        },
        onRunFailed,
        onRunFinalized,
      },
    );
    await waitForRuns(agent, 1);
    await vi.waitFor(() => expect(releaseFirst).toBeDefined());

    // Queued before the detach: already received, so it is still applied.
    const queued: TextMessageStartEvent = {
      type: EventType.TEXT_MESSAGE_START,
      messageId: "queued",
      role: "assistant",
    };
    agent.open[0].next(queued);
    const detached = agent.detachActiveRun();
    agent.open[0].next({ ...queued, messageId: "after-detach" });
    agent.open[0].error(new Error("stream failed after detach"));
    releaseFirst?.();

    await detached;
    await expect(run).resolves.toEqual({
      result: undefined,
      newMessages: [{ id: "queued", role: "assistant", content: "" }],
    });
    expect(seen).toEqual([EventType.RUN_STARTED, EventType.TEXT_MESSAGE_START]);
    expect(agent.teardowns).toBe(1);
    expect(onRunFailed).not.toHaveBeenCalled();
    expect(onRunFinalized).toHaveBeenCalledTimes(1);
    expect(agent.isRunning).toBe(false);
  });

  it("is a no-op when idle and does not affect a later run", async () => {
    const agent = new HangingAgent({ debug: false });
    await agent.detachActiveRun();
    expect(agent.open).toHaveLength(0);
    expect(agent.teardowns).toBe(0);

    const later = agent.runAgent({ runId: "after-idle-detach" });
    await waitForRuns(agent, 1);
    expect(agent.teardowns).toBe(0);

    await agent.detachActiveRun();
    await later;
    expect(agent.teardowns).toBe(1);
  });

  it("can detach after recovering from a synchronous startup failure", async () => {
    const agent = new StartupFailureAgent({ debug: false });
    await expect(agent.runAgent()).rejects.toThrow("startup failed");
    await expect(agent.runAgent()).resolves.toEqual({ result: undefined, newMessages: [] });
    expect(agent.isRunning).toBe(false);
    await expect(agent.detachActiveRun()).resolves.toBeUndefined();
  });
});

describe("active run identity", () => {
  it.each(["runAgent", "connectAgent"] as const)(
    "%s exposes the run it is executing and clears it when the run ends",
    async (method) => {
      const agent = new HangingAgent({ debug: false, threadId: "identity-thread" });
      const seen: Array<AbstractAgent["activeRun"]> = [];
      expect(agent.activeRun).toBeUndefined();

      const run = agent[method](
        { runId: "identity-run" },
        { onRunFinalized: ({ agent }) => void seen.push(agent.activeRun) },
      );
      await waitForRuns(agent, 1);
      expect(agent.activeRun).toEqual({ threadId: "identity-thread", runId: "identity-run" });

      // A host switching threads mid-run does not rewrite the run's identity.
      agent.threadId = "other-thread";
      expect(agent.activeRun?.threadId).toBe("identity-thread");

      await agent.detachActiveRun();
      expect(agent.activeRun).toBeUndefined();
      await run;
      expect(agent.activeRun).toBeUndefined();
      expect(seen).toEqual([undefined]);
    },
  );

  it("is cleared after a run that fails to start", async () => {
    const agent = new StartupFailureAgent({ debug: false });
    await expect(agent.runAgent({ runId: "fails" })).rejects.toThrow("startup failed");
    expect(agent.activeRun).toBeUndefined();
  });

  it("is not cleared by an older run that finishes after a newer one started", async () => {
    const agent = new HangingAgent({ debug: false, threadId: "identity-thread" });
    const first = agent.runAgent({ runId: "older" });
    await waitForRuns(agent, 1);
    const second = agent.runAgent({ runId: "newer" });
    await waitForRuns(agent, 2);
    expect(agent.activeRun?.runId).toBe("newer");

    agent.open[0].complete();
    await first;
    expect(agent.activeRun).toEqual({ threadId: "identity-thread", runId: "newer" });

    agent.open[1].complete();
    await second;
    expect(agent.activeRun).toBeUndefined();
  });
});

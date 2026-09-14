import { Observable } from "rxjs";
import { AbstractAgent } from "../agent";
import { AgentSubscriber } from "../subscriber";
import { AGUIError, BaseEvent, EventType, RunAgentInput } from "@ag-ui/core";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Duration of the simulated async `onRunInitialized`, i.e. the width of the window. */
const INIT_MS = 60;
/** Offset at which the competing request lands — comfortably inside the window. */
const INSIDE_WINDOW_MS = 20;
/** How long the simulated run streams for. */
const RUN_MS = 40;

/**
 * Agent that reports how many of its runs were live at once and whether its
 * stream was ever subscribed, so a test can tell a cancelled run apart from a
 * run that merely finished quickly.
 */
class PreemptionProbeAgent extends AbstractAgent {
  /** Number of times the underlying stream was actually subscribed. */
  public starts = 0;
  /** Highest number of simultaneously live streams observed. */
  public maxConcurrentRuns = 0;
  private liveRuns = 0;

  constructor() {
    super({ agentId: "preemption-probe", threadId: "thread-1" });
    this.debug = false;
  }

  private stream(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      this.starts++;
      this.liveRuns++;
      this.maxConcurrentRuns = Math.max(this.maxConcurrentRuns, this.liveRuns);
      let finished = false;

      const timer = setTimeout(() => {
        subscriber.next({
          type: EventType.RUN_STARTED,
          threadId: input.threadId,
          runId: input.runId,
        } as BaseEvent);
        subscriber.next({
          type: EventType.TEXT_MESSAGE_START,
          messageId: `msg-${input.runId}`,
          role: "assistant",
        } as BaseEvent);
        subscriber.next({
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: `msg-${input.runId}`,
          delta: "streamed",
        } as BaseEvent);
        subscriber.next({
          type: EventType.TEXT_MESSAGE_END,
          messageId: `msg-${input.runId}`,
        } as BaseEvent);
        subscriber.next({
          type: EventType.RUN_FINISHED,
          threadId: input.threadId,
          runId: input.runId,
        } as BaseEvent);
        finished = true;
        this.liveRuns--;
        subscriber.complete();
      }, RUN_MS);

      return () => {
        clearTimeout(timer);
        if (!finished) {
          this.liveRuns--;
        }
      };
    });
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    return this.stream(input);
  }

  protected connect(input: RunAgentInput): Observable<BaseEvent> {
    return this.stream(input);
  }
}

/** Subscriber whose `onRunInitialized` is async, which is what opens the window. */
const asyncInitSubscriber = (): AgentSubscriber => ({
  onRunInitialized: async () => {
    await delay(INIT_MS);
  },
});

const assistantMessages = (agent: AbstractAgent) =>
  agent.messages.filter((message) => message.role === "assistant");

type Entry = "runAgent" | "connectAgent";

const start = (agent: PreemptionProbeAgent, entry: Entry) =>
  entry === "runAgent" ? agent.runAgent() : agent.connectAgent();

describe.each<Entry>(["runAgent", "connectAgent"])(
  "%s pre-emption during the onInitialize window",
  (entry) => {
    it("cancels the in-flight run when a detach arrives before initialization resolves", async () => {
      const agent = new PreemptionProbeAgent();
      agent.subscribe(asyncInitSubscriber());

      const inFlight = start(agent, entry);
      await delay(INSIDE_WINDOW_MS);

      // The window: initialization has not resolved, so the run's pipeline does
      // not exist yet. The detach must still take effect.
      await agent.detachActiveRun();

      // detachActiveRun resolves only once the run it cancelled has settled.
      expect(agent.isRunning).toBe(false);

      await Promise.allSettled([inFlight]);

      // Cancellation, not just a settled promise: the stream never ran and
      // nothing it would have produced was applied to the agent.
      expect(agent.starts).toBe(0);
      expect(assistantMessages(agent)).toHaveLength(0);
    });

    it("does not start a second run concurrently when one is requested inside the window", async () => {
      const agent = new PreemptionProbeAgent();
      agent.subscribe(asyncInitSubscriber());

      // Mirrors the consumer guard: detach whatever is active, then run.
      const send = async () => {
        await agent.detachActiveRun();
        return start(agent, entry);
      };

      const first = send();
      await delay(INSIDE_WINDOW_MS);
      const second = send();

      await Promise.allSettled([first, second]);

      expect(agent.maxConcurrentRuns).toBe(1);
      expect(agent.isRunning).toBe(false);
    });

    it("releases the active-run handles when initialization throws", async () => {
      const agent = new PreemptionProbeAgent();
      // A pending interrupt that the run does not resume makes onInitialize throw.
      agent.pendingInterrupts = [{ id: "interrupt-1" } as never];

      await expect(start(agent, entry)).rejects.toBeInstanceOf(AGUIError);

      // A later detach must not await a completion promise that can never settle.
      await expect(
        Promise.race([
          agent.detachActiveRun().then(() => "detached"),
          delay(200).then(() => "timed out"),
        ]),
      ).resolves.toBe("detached");

      expect(agent.isRunning).toBe(false);
    });
  },
);

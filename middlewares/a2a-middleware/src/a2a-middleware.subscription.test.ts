import { describe, it, expect } from "vitest";
import { Observable } from "rxjs";
import {
  AbstractAgent,
  BaseEvent,
  EventType,
  RunAgentInput,
} from "@ag-ui/client";
import { A2AMiddlewareAgent } from "./index";

const TOOL_NAME = "send_message_to_a2a_agent";

/**
 * A cold orchestrator, the way HttpAgent is: every subscription to the observable returned by
 * run() is a separate run (a separate HTTP request in the real thing). It counts subscriptions
 * and gives each one its own tool call id, the way two independent LLM calls would.
 */
class CountingOrchestrationAgent extends AbstractAgent {
  subscriptions = 0;

  constructor(private readonly emitAsync: boolean) {
    super();
  }

  run(_input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((observer) => {
      this.subscriptions += 1;
      const toolCallId = `call-${this.subscriptions}`;
      const events: BaseEvent[] = [
        { type: EventType.RUN_STARTED, threadId: "t1", runId: "r1" } as BaseEvent,
        {
          type: EventType.TOOL_CALL_START,
          toolCallId,
          toolCallName: TOOL_NAME,
        } as BaseEvent,
        {
          type: EventType.TOOL_CALL_ARGS,
          toolCallId,
          delta: JSON.stringify({ agentName: "remote-agent", task: "hi" }),
        } as BaseEvent,
        { type: EventType.TOOL_CALL_END, toolCallId } as BaseEvent,
        { type: EventType.RUN_FINISHED, threadId: "t1", runId: "r1" } as BaseEvent,
      ];
      const emit = () => {
        for (const event of events) observer.next(event);
        observer.complete();
      };
      if (this.emitAsync) {
        const timer = setTimeout(emit, 0);
        return () => clearTimeout(timer);
      }
      emit();
      return undefined;
    });
  }
}

const makeInput = (): RunAgentInput =>
  ({
    threadId: "t1",
    runId: "r1",
    messages: [],
    tools: [],
    context: [],
    state: {},
    forwardedProps: {},
  }) as RunAgentInput;

const collect = (agent: A2AMiddlewareAgent, timeoutMs = 2000) =>
  new Promise<{ events: BaseEvent[]; error?: unknown }>((resolve, reject) => {
    const events: BaseEvent[] = [];
    const timer = setTimeout(
      () => reject(new Error("stream neither completed nor errored (hang)")),
      timeoutMs,
    );
    agent.run(makeInput()).subscribe({
      next: (event) => events.push(event),
      error: (error) => {
        clearTimeout(timer);
        resolve({ events, error });
      },
      complete: () => {
        clearTimeout(timer);
        resolve({ events });
      },
    });
  });

const runErrorMessage = (events: BaseEvent[]) =>
  (events.find((e) => e.type === EventType.RUN_ERROR) as { message?: string } | undefined)
    ?.message;

/*
 * wrapStream's applyAndProcessEvents subscribes to the orchestrator stream to apply it to the
 * middleware's messages, then hands the same cold observable back to the outer pipe, which
 * subscribes to it again. Every orchestrator turn therefore runs twice, and the messages the
 * RUN_FINISHED handler reads come from the other run, not the one it is handling.
 *
 * These are `it.fails`: they pin the current (wrong) behaviour, so they start failing, and must
 * be flipped to `it`, once the stream is subscribed to only once.
 */
describe("A2AMiddlewareAgent orchestrator subscription", () => {
  it.fails("subscribes to the orchestrator run exactly once", async () => {
    const orchestrator = new CountingOrchestrationAgent(true);
    const agent = new A2AMiddlewareAgent({
      agentUrls: [],
      orchestrationAgent: orchestrator,
    });

    await collect(agent);

    expect(orchestrator.subscriptions).toBe(1);
  });

  // With no A2A agents configured, a correctly resolved tool call ends in `Agent "remote-agent"
  // not found`. Anything else means the arguments the orchestrator streamed were never found.
  it.fails(
    "resolves the A2A tool call arguments from the run it is handling (async orchestrator)",
    async () => {
      const agent = new A2AMiddlewareAgent({
        agentUrls: [],
        orchestrationAgent: new CountingOrchestrationAgent(true),
      });

      const { events } = await collect(agent);

      expect(runErrorMessage(events)).toMatch(/Agent "remote-agent" not found/);
    },
  );

  it.fails(
    "resolves the A2A tool call arguments from the run it is handling (sync orchestrator)",
    async () => {
      const agent = new A2AMiddlewareAgent({
        agentUrls: [],
        orchestrationAgent: new CountingOrchestrationAgent(false),
      });

      const { events } = await collect(agent);

      expect(runErrorMessage(events)).toMatch(/Agent "remote-agent" not found/);
    },
  );
});

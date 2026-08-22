import { describe, it, expect } from "vitest";
import { Observable } from "rxjs";
import {
  AbstractAgent,
  BaseEvent,
  EventType,
  RunAgentInput,
  Message,
} from "@ag-ui/client";
import { A2AMiddlewareAgent } from "./index";

class StubOrchestrationAgent extends AbstractAgent {
  constructor(private readonly events: BaseEvent[]) {
    super();
  }

  run(_input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((observer) => {
      for (const event of this.events) {
        observer.next(event);
      }
      observer.complete();
    });
  }
}

const TOOL_CALL_ID = "call-1";
const TOOL_NAME = "send_message_to_a2a_agent";

const orchestrationEvents = (): BaseEvent[] => [
  { type: EventType.RUN_STARTED, threadId: "t1", runId: "r1" } as BaseEvent,
  {
    type: EventType.TOOL_CALL_START,
    toolCallId: TOOL_CALL_ID,
    toolCallName: TOOL_NAME,
  } as BaseEvent,
  { type: EventType.TOOL_CALL_END, toolCallId: TOOL_CALL_ID } as BaseEvent,
  { type: EventType.RUN_FINISHED, threadId: "t1", runId: "r1" } as BaseEvent,
];

const assistantMessageWithArgs = (args: string): Message =>
  ({
    id: "msg-1",
    role: "assistant",
    content: "",
    toolCalls: [
      {
        id: TOOL_CALL_ID,
        type: "function",
        function: { name: TOOL_NAME, arguments: args },
      },
    ],
  }) as Message;

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

/**
 * Collects the events emitted by the middleware, resolving on terminal
 * completion or error. Rejects if the stream neither completes nor errors,
 * which is the "hang" symptom of issue #2444.
 */
const collect = (agent: A2AMiddlewareAgent, timeoutMs = 2000) =>
  new Promise<{ events: BaseEvent[]; error?: unknown; completed: boolean }>(
    (resolve, reject) => {
      const events: BaseEvent[] = [];
      const timer = setTimeout(
        () => reject(new Error("stream neither completed nor errored (hang)")),
        timeoutMs,
      );
      agent.run(makeInput()).subscribe({
        next: (event) => events.push(event),
        error: (error) => {
          clearTimeout(timer);
          resolve({ events, error, completed: false });
        },
        complete: () => {
          clearTimeout(timer);
          resolve({ events, completed: true });
        },
      });
    },
  );

describe("A2AMiddlewareAgent error handling (issue #2444)", () => {
  it("surfaces a RUN_ERROR when the pending tool call arguments are malformed JSON", async () => {
    const agent = new A2AMiddlewareAgent({
      agentUrls: [],
      orchestrationAgent: new StubOrchestrationAgent(orchestrationEvents()),
    });
    agent.messages = [assistantMessageWithArgs('{"agentName": "some-agent"')];

    const result = await collect(agent);

    const runError = result.events.find((e) => e.type === EventType.RUN_ERROR);
    expect(runError, "expected a RUN_ERROR event on the stream").toBeDefined();
    expect((runError as any).message).toMatch(new RegExp(TOOL_CALL_ID));
  });

  it("surfaces a RUN_ERROR when the A2A call rejects", async () => {
    const agent = new A2AMiddlewareAgent({
      agentUrls: [],
      orchestrationAgent: new StubOrchestrationAgent(orchestrationEvents()),
    });
    agent.messages = [
      assistantMessageWithArgs(
        JSON.stringify({ agentName: "missing-agent", task: "hi" }),
      ),
    ];

    const result = await collect(agent);

    const runError = result.events.find((e) => e.type === EventType.RUN_ERROR);
    expect(runError, "expected a RUN_ERROR event on the stream").toBeDefined();
    expect((runError as any).message).toMatch(/missing-agent/);
  });
});

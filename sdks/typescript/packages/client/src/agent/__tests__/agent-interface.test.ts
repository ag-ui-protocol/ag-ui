import { describe, it, expect, expectTypeOf } from "vitest";
import { lastValueFrom, of, toArray, type Observable } from "rxjs";
import { map } from "rxjs/operators";
import {
  EventType,
  type BaseEvent,
  type RunAgentInput,
  type RunFinishedEvent,
  type RunStartedEvent,
  type TextMessageContentEvent,
  type TextMessageEndEvent,
  type TextMessageStartEvent,
  type ToolCallArgsEvent,
  type ToolCallEndEvent,
  type ToolCallStartEvent,
} from "@ag-ui/core";
import { AbstractAgent } from "@/agent/agent";
import type { Agent } from "@/agent/types";
import type { AgentSubscriber, AgentSubscriberParams } from "@/agent/subscriber";
import { Middleware, type MiddlewareNext } from "@/middleware/middleware";
import { FilterToolCallsMiddleware } from "@/middleware/filter-tool-calls";

const THREAD_ID = "thread-1";
const RUN_ID = "run-1";

function createInput(): RunAgentInput {
  return {
    threadId: THREAD_ID,
    runId: RUN_ID,
    messages: [],
    tools: [],
    context: [],
    forwardedProps: {},
  };
}

const runStarted: RunStartedEvent = {
  type: EventType.RUN_STARTED,
  threadId: THREAD_ID,
  runId: RUN_ID,
};
const runFinished: RunFinishedEvent = {
  type: EventType.RUN_FINISHED,
  threadId: THREAD_ID,
  runId: RUN_ID,
};

function textMessageEvents(text: string) {
  const start: TextMessageStartEvent = {
    type: EventType.TEXT_MESSAGE_START,
    messageId: "msg-1",
    role: "assistant",
  };
  const content: TextMessageContentEvent = {
    type: EventType.TEXT_MESSAGE_CONTENT,
    messageId: "msg-1",
    delta: text,
  };
  const end: TextMessageEndEvent = { type: EventType.TEXT_MESSAGE_END, messageId: "msg-1" };
  return [runStarted, start, content, end, runFinished];
}

function toolCallEvents(toolCallId: string, toolCallName: string) {
  const start: ToolCallStartEvent = { type: EventType.TOOL_CALL_START, toolCallId, toolCallName };
  const args: ToolCallArgsEvent = { type: EventType.TOOL_CALL_ARGS, toolCallId, delta: "{}" };
  const end: ToolCallEndEvent = { type: EventType.TOOL_CALL_END, toolCallId };
  return [start, args, end];
}

/** A `MiddlewareNext` that is a plain object, not an agent. */
function createPlainNext(events: BaseEvent[]): MiddlewareNext {
  return { run: () => of(...events), messages: [], state: {} };
}

class ScriptedAgent extends AbstractAgent {
  constructor(private readonly events: BaseEvent[]) {
    super();
  }

  run(): Observable<BaseEvent> {
    return of(...this.events);
  }
}

/** Middleware written against 1.x: `next` is typed `AbstractAgent`. */
class UppercaseTextMiddleware extends Middleware {
  run(input: RunAgentInput, next: AbstractAgent): Observable<BaseEvent> {
    return this.runNext(input, next).pipe(
      map((event) =>
        event.type === EventType.TEXT_MESSAGE_CONTENT
          ? { ...event, delta: String(event.delta).toUpperCase() }
          : event,
      ),
    );
  }
}

/** Exposes the protected `runNextWithState` so a test can call it. */
class StateTrackingMiddleware extends Middleware {
  run(input: RunAgentInput, next: MiddlewareNext): Observable<BaseEvent> {
    return this.runNext(input, next);
  }

  trackState(input: RunAgentInput, next: MiddlewareNext) {
    return this.runNextWithState(input, next);
  }
}

describe("AgentSubscriber type parameter", () => {
  it("defaults params.agent to AbstractAgent", () => {
    expectTypeOf<AgentSubscriberParams["agent"]>().toEqualTypeOf<AbstractAgent>();
    expectTypeOf<
      Parameters<NonNullable<AgentSubscriber["onRunInitialized"]>>[0]["agent"]
    >().toEqualTypeOf<AbstractAgent>();
  });

  it("types params.agent as Agent in AgentSubscriber<Agent> callbacks", () => {
    const subscriber: AgentSubscriber<Agent> = {
      onRunInitialized: ({ agent }) => {
        expectTypeOf(agent).toEqualTypeOf<Agent>();
      },
      onEvent: ({ agent }) => {
        expectTypeOf(agent).toEqualTypeOf<Agent>();
      },
      onMessagesChanged: ({ agent }) => {
        expectTypeOf(agent).toEqualTypeOf<Agent>();
      },
    };
    expectTypeOf(subscriber.onRunInitialized).not.toBeUndefined();
  });
});

describe("MiddlewareNext", () => {
  it("accepts a Middleware subclass whose run still takes next: AbstractAgent", async () => {
    const agent = new ScriptedAgent(textMessageEvents("hello"));
    agent.use(new UppercaseTextMiddleware());

    const { newMessages } = await agent.runAgent();

    expect(newMessages).toEqual([{ id: "msg-1", role: "assistant", content: "HELLO" }]);
  });

  it("lets a built-in middleware run a plain { run, messages, state } object", async () => {
    const next = createPlainNext([
      runStarted,
      ...toolCallEvents("call-1", "calculator"),
      ...toolCallEvents("call-2", "weather"),
      runFinished,
    ]);
    const middleware = new FilterToolCallsMiddleware({ disallowedToolCalls: ["calculator"] });

    const events = await lastValueFrom(middleware.run(createInput(), next).pipe(toArray()));

    expect(events).toEqual([runStarted, ...toolCallEvents("call-2", "weather"), runFinished]);
  });

  it("tracks messages in runNextWithState when next is a plain object", async () => {
    const next = createPlainNext(textMessageEvents("hello"));

    const tracked = await lastValueFrom(
      new StateTrackingMiddleware().trackState(createInput(), next).pipe(toArray()),
    );

    expect(tracked.at(-1)?.messages).toEqual([
      { id: "msg-1", role: "assistant", content: "hello" },
    ]);
  });

  it("requires messages and state, not only run", () => {
    const middleware = new FilterToolCallsMiddleware({ allowedToolCalls: [] });
    // @ts-expect-error -- MiddlewareNext also needs messages and state
    middleware.run(createInput(), { run: () => of(runStarted) });
  });
});

import { AbstractAgent } from "@/agent";
import { FilterToolCallsMiddleware } from "@/middleware/filter-tool-calls";
import {
  BaseEvent,
  EventType,
  RunAgentInput,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  ToolCallResultEvent,
  ToolCallStartEvent,
} from "@ag-ui/core";
import { Observable } from "rxjs";
import { toArray } from "rxjs/operators";

/**
 * Emits a run that starts a tool call and is then interrupted: no
 * TOOL_CALL_RESULT is ever produced for it.
 */
class InterruptedToolCallAgent extends AbstractAgent {
  constructor(
    private readonly toolCallId: string,
    private readonly toolCallName: string,
  ) {
    super();
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      subscriber.next({
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      });
      subscriber.next({
        type: EventType.TOOL_CALL_START,
        toolCallId: this.toolCallId,
        toolCallName: this.toolCallName,
        parentMessageId: "message-1",
      } as ToolCallStartEvent);
      subscriber.next({
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: this.toolCallId,
        delta: "{}",
      } as ToolCallArgsEvent);
      subscriber.next({
        type: EventType.TOOL_CALL_END,
        toolCallId: this.toolCallId,
      } as ToolCallEndEvent);
      // Interrupted: no TOOL_CALL_RESULT, no RUN_FINISHED.
      subscriber.complete();
    });
  }
}

/** Emits a complete tool call lifecycle. */
class CompleteToolCallAgent extends AbstractAgent {
  constructor(
    private readonly toolCallId: string,
    private readonly toolCallName: string,
  ) {
    super();
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      subscriber.next({
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      });
      subscriber.next({
        type: EventType.TOOL_CALL_START,
        toolCallId: this.toolCallId,
        toolCallName: this.toolCallName,
        parentMessageId: "message-1",
      } as ToolCallStartEvent);
      subscriber.next({
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: this.toolCallId,
        delta: '{"a": 1}',
      } as ToolCallArgsEvent);
      subscriber.next({
        type: EventType.TOOL_CALL_END,
        toolCallId: this.toolCallId,
      } as ToolCallEndEvent);
      subscriber.next({
        type: EventType.TOOL_CALL_RESULT,
        messageId: "tool-message-1",
        toolCallId: this.toolCallId,
        content: "ok",
      } as ToolCallResultEvent);
      subscriber.next({
        type: EventType.RUN_FINISHED,
        threadId: input.threadId,
        runId: input.runId,
      });
      subscriber.complete();
    });
  }
}

const makeInput = (runId: string): RunAgentInput => ({
  threadId: "thread-1",
  runId,
  messages: [],
  tools: [],
  context: [],
  state: {},
  forwardedProps: {},
});

const blockedIds = (middleware: FilterToolCallsMiddleware): Set<string> =>
  (middleware as unknown as { blockedToolCallIds: Set<string> }).blockedToolCallIds;

describe("FilterToolCallsMiddleware - run boundaries (issue #2443)", () => {
  it("does not carry blocked tool call IDs into the next run", async () => {
    const middleware = new FilterToolCallsMiddleware({
      disallowedToolCalls: ["blocked_tool"],
    });
    const sharedToolCallId = "tool-call-1";

    // Run 1: blocked tool call, interrupted before TOOL_CALL_RESULT.
    await middleware
      .run(makeInput("run-1"), new InterruptedToolCallAgent(sharedToolCallId, "blocked_tool"))
      .pipe(toArray())
      .toPromise();

    // Run 2: the same tool call ID is reused by an allowed tool.
    const secondRunEvents = (await middleware
      .run(makeInput("run-2"), new CompleteToolCallAgent(sharedToolCallId, "allowed_tool"))
      .pipe(toArray())
      .toPromise()) as BaseEvent[];

    const types = secondRunEvents.map((event) => event.type);
    expect(types).toContain(EventType.TOOL_CALL_START);
    expect(types).toContain(EventType.TOOL_CALL_ARGS);
    expect(types).toContain(EventType.TOOL_CALL_END);
    expect(types).toContain(EventType.TOOL_CALL_RESULT);
  });

  it("does not accumulate blocked tool call IDs across interrupted runs", async () => {
    const middleware = new FilterToolCallsMiddleware({
      disallowedToolCalls: ["blocked_tool"],
    });

    for (let i = 0; i < 5; i++) {
      await middleware
        .run(makeInput(`run-${i}`), new InterruptedToolCallAgent(`tool-call-${i}`, "blocked_tool"))
        .pipe(toArray())
        .toPromise();
    }

    expect(blockedIds(middleware).size).toBe(0);
  });

  it("clears blocked tool call IDs left behind by a stalled run when the next run starts", () => {
    const middleware = new FilterToolCallsMiddleware({
      disallowedToolCalls: ["blocked_tool"],
    });

    // A run that emits a blocked tool call and then stalls: it never
    // completes, errors or gets unsubscribed.
    class StalledAgent extends AbstractAgent {
      run(input: RunAgentInput): Observable<BaseEvent> {
        return new Observable<BaseEvent>((subscriber) => {
          subscriber.next({
            type: EventType.RUN_STARTED,
            threadId: input.threadId,
            runId: input.runId,
          });
          subscriber.next({
            type: EventType.TOOL_CALL_START,
            toolCallId: "tool-call-1",
            toolCallName: "blocked_tool",
            parentMessageId: "message-1",
          } as ToolCallStartEvent);
        });
      }
    }

    middleware.run(makeInput("run-1"), new StalledAgent()).subscribe();
    expect(blockedIds(middleware).size).toBe(1);

    // Starting the next run must not inherit the stalled run's state.
    middleware.run(makeInput("run-2"), new CompleteToolCallAgent("tool-call-2", "allowed_tool"));
    expect(blockedIds(middleware).size).toBe(0);
  });

  it("clears blocked tool call IDs when a run is unsubscribed mid-stream", async () => {
    const middleware = new FilterToolCallsMiddleware({
      disallowedToolCalls: ["blocked_tool"],
    });

    const subscription = middleware
      .run(makeInput("run-1"), new InterruptedToolCallAgent("tool-call-1", "blocked_tool"))
      .subscribe();
    subscription.unsubscribe();

    expect(blockedIds(middleware).size).toBe(0);
  });
});

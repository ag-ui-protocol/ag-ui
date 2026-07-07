import { describe, it, expect } from "vitest";
import { AbstractAgent } from "@/agent";
import { BaseEvent, EventType, RunAgentInput } from "@ag-ui/core";
import { Observable, from, lastValueFrom, toArray } from "rxjs";
import { BackwardCompatibility_0_0_57 } from "../backward-compatibility-0-0-57";

// Mock agent that records the input it received and replays a scripted stream.
class MockAgent extends AbstractAgent {
  public lastInput?: RunAgentInput;
  private events: BaseEvent[];

  constructor(events: BaseEvent[] = []) {
    super({});
    this.events = events;
  }

  override get maxVersion(): string {
    return "0.0.57";
  }

  override run(input: RunAgentInput): Observable<BaseEvent> {
    this.lastInput = input;
    return from(this.events);
  }
}

const createInput = (overrides: Partial<RunAgentInput> = {}): RunAgentInput => ({
  threadId: "thread-1",
  runId: "run-1",
  state: {},
  messages: [],
  tools: [],
  context: [],
  forwardedProps: {},
  ...overrides,
});

describe("BackwardCompatibility_0_0_57", () => {
  it("strips subagentId from input messages before the agent sees them", async () => {
    const middleware = new BackwardCompatibility_0_0_57();
    const agent = new MockAgent([]);
    const input = createInput({
      messages: [
        { id: "m1", role: "assistant", content: "hi", subagentId: "sub-1" } as any,
        { id: "m2", role: "user", content: "yo" } as any,
      ],
    });

    await lastValueFrom(middleware.run(input, agent).pipe(toArray()));

    expect((agent.lastInput!.messages[0] as any).subagentId).toBeUndefined();
    expect(agent.lastInput!.messages[0].content).toBe("hi");
    expect((agent.lastInput!.messages[1] as any).subagentId).toBeUndefined();
  });

  it("drops SUBAGENT_STARTED/FINISHED/ERROR events from the output stream", async () => {
    const middleware = new BackwardCompatibility_0_0_57();
    const events: BaseEvent[] = [
      { type: EventType.RUN_STARTED, threadId: "thread-1", runId: "run-1" } as any,
      { type: EventType.SUBAGENT_STARTED, subagentId: "s1", name: "R" } as any,
      { type: EventType.TEXT_MESSAGE_START, messageId: "m1", subagentId: "s1" } as any,
      { type: EventType.SUBAGENT_ERROR, subagentId: "s1", message: "x" } as any,
      { type: EventType.SUBAGENT_FINISHED, subagentId: "s1" } as any,
      { type: EventType.RUN_FINISHED, threadId: "thread-1", runId: "run-1" } as any,
    ];

    const result = await lastValueFrom(
      middleware.run(createInput(), new MockAgent(events)).pipe(toArray()),
    );

    const types = result.map((e) => e.type);
    expect(types).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.RUN_FINISHED,
    ]);
  });

  it("strips subagentId from surviving events", async () => {
    const middleware = new BackwardCompatibility_0_0_57();
    const events: BaseEvent[] = [
      { type: EventType.TEXT_MESSAGE_START, messageId: "m1", subagentId: "s1" } as any,
    ];

    const result = await lastValueFrom(
      middleware.run(createInput(), new MockAgent(events)).pipe(toArray()),
    );

    expect((result[0] as any).subagentId).toBeUndefined();
    expect((result[0] as any).messageId).toBe("m1");
  });

  it("strips subagentId from messages inside MESSAGES_SNAPSHOT", async () => {
    const middleware = new BackwardCompatibility_0_0_57();
    const events: BaseEvent[] = [
      {
        type: EventType.MESSAGES_SNAPSHOT,
        messages: [
          { id: "m1", role: "assistant", content: "hi", subagentId: "s1" },
          { id: "m2", role: "user", content: "yo" },
        ],
      } as any,
    ];

    const result = await lastValueFrom(
      middleware.run(createInput(), new MockAgent(events)).pipe(toArray()),
    );

    const snapshot = result[0] as any;
    expect(snapshot.messages[0].subagentId).toBeUndefined();
    expect(snapshot.messages[0].content).toBe("hi");
    expect(snapshot.messages[1].subagentId).toBeUndefined();
  });

  it("leaves a subagent-free stream and input untouched", async () => {
    const middleware = new BackwardCompatibility_0_0_57();
    const events: BaseEvent[] = [
      { type: EventType.RUN_STARTED, threadId: "thread-1", runId: "run-1" } as any,
      { type: EventType.TEXT_MESSAGE_START, messageId: "m1", role: "assistant" } as any,
      { type: EventType.RUN_FINISHED, threadId: "thread-1", runId: "run-1" } as any,
    ];
    const agent = new MockAgent(events);
    const input = createInput({ messages: [{ id: "m0", role: "user", content: "hi" } as any] });

    const result = await lastValueFrom(middleware.run(input, agent).pipe(toArray()));

    expect(result.map((e) => e.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.RUN_FINISHED,
    ]);
    expect(agent.lastInput!.messages[0].content).toBe("hi");
  });
});

import {
  AbstractAgent,
  EventType,
  type BaseEvent,
  type RunAgentInput,
} from "@ag-ui/client";
import { from, Subject } from "rxjs";
import { describe, expect, it } from "vitest";
import { A2UIMiddleware } from "../src";
import { collectEvents, createRunAgentInput } from "./test-utils";

class SequenceAgent extends AbstractAgent {
  calls: RunAgentInput[] = [];
  constructor(
    private events: (input: RunAgentInput, turn: number) => BaseEvent[],
  ) {
    super();
  }
  run(input: RunAgentInput) {
    this.calls.push(input);
    return from(this.events(input, this.calls.length - 1));
  }
}
const finish = (input: RunAgentInput): BaseEvent => ({
  type: EventType.RUN_FINISHED,
  threadId: input.threadId,
  runId: input.runId,
});
const turn = (input: RunAgentInput, id: string): BaseEvent[] => [
  { type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId },
  {
    type: EventType.TOOL_CALL_START,
    toolCallId: id,
    toolCallName: "render_a2ui",
  },
  {
    type: EventType.TOOL_CALL_ARGS,
    toolCallId: id,
    delta: '{"components":[]}',
  },
  { type: EventType.TOOL_CALL_END, toolCallId: id },
  finish(input),
];

describe("bounded A2UI completion", () => {
  it.each(["top-level", "legacy", "both"] as const)(
    "returns invalid rendering to the original call as an error, without replaying a %s approval",
    async (channel) => {
      const agent = new SequenceAgent((input, index) =>
        index < 2 ? turn(input, `original-${index}`) : [finish(input)],
      );
      const input = createRunAgentInput({
        ...(channel !== "legacy"
          ? {
              resume: [
                {
                  interruptId: "old",
                  status: "resolved" as const,
                  payload: {},
                },
              ],
            }
          : {}),
        forwardedProps: {
          threadMetadata: { source: "approval-test" },
          command: {
            ...(channel !== "top-level" ? { resume: "approved" } : {}),
            update: { approved: true },
          },
        },
        context: [{ description: "approval context", value: "keep this" }],
      });
      const originalInput = structuredClone(input);
      await collectEvents(new A2UIMiddleware().run(input, agent));
      expect(agent.calls).toHaveLength(3);
      expect(agent.calls[0].resume).toEqual(originalInput.resume);
      expect(agent.calls[0].forwardedProps).toEqual(
        originalInput.forwardedProps,
      );
      for (const continuation of agent.calls.slice(1)) {
        expect(continuation.resume).toBeUndefined();
        expect(continuation.forwardedProps).toEqual({
          threadMetadata: { source: "approval-test" },
          command: { update: { approved: true } },
        });
        expect(continuation.context).toEqual(originalInput.context);
      }
      expect(input).toEqual(originalInput);
      expect(agent.calls[1].messages).toContainEqual(
        expect.objectContaining({
          role: "tool",
          toolCallId: "original-0",
          error: "",
          content: expect.stringContaining('"status":"failed"'),
        }),
      );
    },
  );
  it.each(["interrupt", "cancelled"] as const)(
    "does not finish or resume a %s run",
    async (type) => {
      const agent = new SequenceAgent((input) => [
        ...turn(input, "original").slice(0, -1),
        {
          ...finish(input),
          outcome:
            type === "interrupt"
              ? { type, interrupts: [{ id: "approval" }] }
              : { type },
        },
      ]);
      const events = await collectEvents(
        new A2UIMiddleware().run(createRunAgentInput(), agent),
      );
      expect(agent.calls).toHaveLength(1);
      expect(
        events.filter((event) => event.type === EventType.TOOL_CALL_RESULT),
      ).toHaveLength(0);
      expect(events.at(-1)).toMatchObject({ outcome: { type } });
    },
  );
  it("leaves another frontend tool pending", async () => {
    const agent = new SequenceAgent((input) => [
      ...turn(input, "original").slice(0, -1),
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "other",
        toolCallName: "ask_user",
      },
      { type: EventType.TOOL_CALL_ARGS, toolCallId: "other", delta: "{}" },
      { type: EventType.TOOL_CALL_END, toolCallId: "other" },
      finish(input),
    ]);
    const events = await collectEvents(
      new A2UIMiddleware().run(createRunAgentInput(), agent),
    );
    expect(agent.calls).toHaveLength(1);
    expect(
      events.filter((event) => event.type === EventType.TOOL_CALL_RESULT),
    ).toHaveLength(1);
  });
  it("bounds fresh calls without an unbounded loop", async () => {
    const agent = new SequenceAgent((input, index) =>
      turn(input, `call-${index}`),
    );
    await expect(
      collectEvents(new A2UIMiddleware().run(createRunAgentInput(), agent)),
    ).rejects.toThrow("continuation limit reached (10)");
    expect(agent.calls).toHaveLength(11);
  });
  it("cancels an active continuation subscription", async () => {
    const pending = new Subject<BaseEvent>();
    let started!: () => void;
    const continuationStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    class Agent extends SequenceAgent {
      override run(input: RunAgentInput) {
        if (this.calls.length === 0) return super.run(input);
        started();
        return pending;
      }
    }
    const agent = new Agent((input) => turn(input, "original"));
    const subscription = new A2UIMiddleware()
      .run(createRunAgentInput(), agent)
      .subscribe();
    // runNextWithState applies events asynchronously.
    await continuationStarted;
    expect(pending.observed).toBe(true);
    subscription.unsubscribe();
    expect(pending.observed).toBe(false);
  });
});

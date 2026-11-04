import { EventType, type BaseEvent } from "@ag-ui/core";
import { describe, expect, it } from "vitest";
import type { SessionEvent } from "../types";
import {
  collect,
  FakeAgentsApi,
  makeAgent,
  runInput,
  types,
} from "./fake-agents-api";

const user = (id: string, content: string) => ({
  id,
  role: "user" as const,
  content,
});
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const textOf = (events: BaseEvent[]) =>
  events
    .filter((event) => event.type === EventType.TEXT_MESSAGE_CONTENT)
    .map((event) => (event as unknown as { delta: string }).delta)
    .join("");
const outcomeOf = (events: BaseEvent[]) =>
  (
    events.find((event) => event.type === EventType.RUN_FINISHED) as unknown as
      | { outcome?: { type: string } }
      | undefined
  )?.outcome;

type EventsApi = {
  create: (...args: unknown[]) => Promise<void>;
};
const eventsApi = (fake: FakeAgentsApi) =>
  (fake.client.beta.agents.sessions as unknown as { events: EventsApi }).events;

describe("recovery and ordering", () => {
  it("does not raise an answered computer-use approval again", async () => {
    const fake = new FakeAgentsApi();
    const agent = makeAgent(fake);
    const action = {
      type: "computer_use_approval_request",
      turn_id: "turn_1",
      request_id: "req_1",
      request: {
        type: "browser_origin_access",
        origin: "https://example.com",
        reason: "Open the page?",
      },
    };
    fake.onCreate = (id) =>
      fake.emit(id, {
        type: "agent.session.requires_action",
        event_id: "e",
        session: {
          ...fake.session(id),
          status: "requires_action",
          required_actions: [action],
        },
      } as unknown as SessionEvent);
    const first = await collect(
      agent,
      runInput({ messages: [user("u1", "Go")] }),
    );
    expect(outcomeOf(first)?.type).toBe("interrupt");

    fake.onSubmit = (id) => {
      fake.emit(id, {
        type: "agent.session.in_progress",
        event_id: "e",
        session: { ...fake.session(id), status: "in_progress" },
      } as SessionEvent);
      setTimeout(() => {
        fake.text(id, "Opened.");
        fake.completeTurn(id);
      }, 80);
    };
    const second = await collect(
      agent,
      runInput({
        messages: [user("u1", "Go")],
        resume: [
          {
            interruptId: "req_1",
            status: "resolved",
            payload: { decision: "approve" },
          },
        ],
      }),
    );
    expect(fake.submissions[0][0]).toMatchObject({
      type: "agent.session.input.computer_use_approval_request_result",
      request_id: "req_1",
      response: { type: "browser_origin_access", decision: "approve" },
    });
    expect(outcomeOf(second)).toBeUndefined();
    expect(textOf(second)).toBe("Opened.");
  });

  it("sends a user message again when the first submit failed", async () => {
    const fake = new FakeAgentsApi();
    const agent = makeAgent(fake);
    fake.onCreate = (id) => {
      fake.text(id, "First");
      fake.completeTurn(id);
    };
    await collect(agent, runInput({ messages: [user("u1", "First")] }));

    const api = eventsApi(fake);
    const original = api.create;
    let failOnce = true;
    api.create = async (...args: unknown[]) => {
      if (failOnce) {
        failOnce = false;
        throw Object.assign(new Error("500 boom"), { status: 500 });
      }
      return original(...args);
    };
    fake.onSubmit = (id) => {
      fake.text(id, "Second");
      fake.completeTurn(id);
    };
    const messages = [
      user("u1", "First"),
      { id: "a1", role: "assistant" as const, content: "First" },
      user("u2", "Second"),
    ];
    const failed = await collect(agent, runInput({ messages }));
    expect(failed.at(-1)?.type).toBe(EventType.RUN_ERROR);

    const retried = await collect(agent, runInput({ messages }));
    expect(textOf(retried)).toBe("Second");
    expect(fake.submissions.at(-1)?.[0]).toMatchObject({
      type: "agent.session.input.message",
    });
  });

  it("surfaces a late backend call before its result", async () => {
    const fake = new FakeAgentsApi();
    const agent = makeAgent(fake, {
      backendTools: [
        {
          name: "lookup",
          description: "Lookup",
          parameters: { type: "object", properties: {} },
          handler: () => "found",
        },
      ],
    });
    let sessionId = "";
    fake.onCreate = (id) => {
      sessionId = id;
      fake.callFunctions(id, [
        { callId: "call_c", name: "change_background", args: {} },
      ]);
    };
    const tools = [
      {
        name: "change_background",
        description: "Change",
        parameters: { type: "object", properties: {} },
      },
    ];
    await collect(agent, runInput({ messages: [user("u1", "Go")], tools }));

    // A backend call arrives after the run ended.
    const session = fake.session(sessionId);
    session.required_actions = [
      ...session.required_actions,
      {
        type: "function_call",
        turn_id: "turn_1",
        call_id: "call_b",
        name: "lookup",
        arguments: {},
      },
    ];
    let submits = 0;
    fake.onSubmit = (id) => {
      if (++submits === 2) {
        fake.text(id, "ok");
        fake.completeTurn(id);
      }
    };
    const second = await collect(
      agent,
      runInput({
        messages: [
          user("u1", "Go"),
          {
            id: "a1",
            role: "assistant",
            toolCalls: [
              {
                id: "call_c",
                type: "function",
                function: { name: "change_background", arguments: "{}" },
              },
            ],
          },
          { id: "t1", role: "tool", toolCallId: "call_c", content: "done" },
        ],
        tools,
      }),
    );
    const order = second.map(
      (event) =>
        `${event.type}:${(event as unknown as { toolCallId?: string }).toolCallId ?? ""}`,
    );
    expect(
      order.indexOf(`${EventType.TOOL_CALL_START}:call_b`),
    ).toBeGreaterThanOrEqual(0);
    expect(order.indexOf(`${EventType.TOOL_CALL_START}:call_b`)).toBeLessThan(
      order.indexOf(`${EventType.TOOL_CALL_RESULT}:call_b`),
    );
  });

  it("completes a message whose deltas were lost to a reconnect", async () => {
    const fake = new FakeAgentsApi();
    const full = "Hello world, this is the rest.";
    fake.onCreate = (id) => {
      const base = {
        event_id: "e",
        session_id: id,
        turn_id: "turn_1",
        output_index: 0,
      };
      const added = {
        ...base,
        type: "agent.session.turn.item.added",
        item: {
          type: "message",
          id: "msg_x",
          role: "assistant",
          content: [],
          status: "in_progress",
          turn_id: "turn_1",
        },
      } as unknown as SessionEvent;
      fake.emit(id, added);
      fake.emit(id, {
        ...base,
        type: "agent.session.turn.output_text.delta",
        item_id: "msg_x",
        content_index: 0,
        delta: "Hello ",
      } as SessionEvent);
      fake.replay.set(id, [
        added,
        {
          ...base,
          type: "agent.session.turn.output_text.done",
          item_id: "msg_x",
          content_index: 0,
          text: full,
        } as SessionEvent,
        {
          ...base,
          type: "agent.session.turn.item.done",
          item: {
            type: "message",
            id: "msg_x",
            role: "assistant",
            content: [{ type: "output_text", text: full }],
            status: "completed",
            turn_id: "turn_1",
          },
        } as unknown as SessionEvent,
        {
          type: "agent.session.turn.completed",
          event_id: "e",
          session_id: id,
          turn_id: "turn_1",
          turn: {
            id: "turn_1",
            subagent_id: null,
            status: "completed",
            error: null,
          },
          usage: null,
        } as unknown as SessionEvent,
      ]);
      // The stream drops mid-message.
      setTimeout(
        () =>
          (
            fake as unknown as { streams: Map<string, { close(): void }> }
          ).streams
            .get(id)
            ?.close(),
        10,
      );
    };
    const events = await collect(
      makeAgent(fake),
      runInput({ messages: [user("u1", "Hi")] }),
    );
    expect(textOf(events)).toBe(full);
    expect(
      types(events).filter((type) => type === EventType.TEXT_MESSAGE_START),
    ).toHaveLength(1);
  });

  it("lets a running backend tool deliver its result when another tool fails the run", async () => {
    const fake = new FakeAgentsApi();
    let slowRuns = 0;
    const agent = makeAgent(fake, {
      backendTools: [
        {
          name: "slow",
          description: "Slow",
          parameters: { type: "object", properties: {} },
          handler: async () => {
            slowRuns++;
            await sleep(60);
            return "slow-done";
          },
        },
        {
          name: "fast",
          description: "Fast",
          parameters: { type: "object", properties: {} },
          handler: () => "fast-done",
        },
      ],
    });
    fake.onCreate = (id) =>
      fake.callFunctions(id, [
        { callId: "call_s", name: "slow", args: {} },
        { callId: "call_f", name: "fast", args: {} },
      ]);
    const api = eventsApi(fake);
    const original = api.create;
    api.create = async (...args: unknown[]) => {
      const body = args[1] as { events: Array<{ call_id?: string }> };
      if (body.events[0]?.call_id === "call_f")
        throw Object.assign(new Error("503 unavailable"), { status: 503 });
      return original(...args);
    };
    const failed = await collect(
      agent,
      runInput({ messages: [user("u1", "Go")] }),
    );
    expect(failed.at(-1)?.type).toBe(EventType.RUN_ERROR);
    expect(
      fake.submissions
        .flat()
        .filter(
          (event) => (event as { call_id?: string }).call_id === "call_s",
        ),
    ).toHaveLength(1);

    // The retry answers only what is still pending: the slow tool is not run again.
    api.create = original;
    fake.onSubmit = (id) => fake.completeTurn(id);
    await collect(agent, runInput({ messages: [user("u1", "Go")] }));
    expect(slowRuns).toBe(1);
  });

  it("cancels a turn it just started even before the turn's events arrive", async () => {
    const fake = new FakeAgentsApi();
    const agent = makeAgent(fake);
    fake.onCreate = (id) => {
      fake.text(id, "One");
      fake.completeTurn(id);
    };
    await collect(agent, runInput({ messages: [user("u1", "One")] }));

    fake.onSubmit = () => {}; // The turn starts, but no events arrive yet.
    const subscription = agent
      .run(
        runInput({
          messages: [
            user("u1", "One"),
            { id: "a1", role: "assistant", content: "One" },
            user("u2", "Two"),
          ],
        }),
      )
      .subscribe(() => {});
    await sleep(30);
    subscription.unsubscribe();
    await sleep(30);
    expect(fake.submissions.at(-1)).toEqual([
      { type: "agent.session.input.cancel" },
    ]);
  });
});

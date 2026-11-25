import { EventType } from "@ag-ui/client";
import type { BaseEvent, RunAgentInput } from "@ag-ui/client";
import { lastValueFrom, toArray } from "rxjs";
import { describe, expect, it } from "vitest";
import { ManagedAgentsAgent } from "../agent";
import { InMemorySessionStore } from "../sessions";
import type { ManagedAgentsAgentConfig, SessionStore } from "../types";
import { createFakeClient } from "./fake-client";

// A thread's second and later runs find a stored session and run through
// recovery. One that sends new input still starts a turn of its own: it must
// stream previews like a first run, and stop the session when abandoned. Only a
// reconnect, which sends nothing, leaves the session running.

const idle = (id: string) => ({
  type: "session.status_idle",
  id,
  stop_reason: { type: "end_turn" },
});
const firstTurn = [idle("idle_1")];
const u1 = { id: "u1", role: "user" as const, content: "Hello" };
const u2 = { id: "u2", role: "user" as const, content: "And now?" };

const input = (
  runId: string,
  messages: RunAgentInput["messages"],
): RunAgentInput => ({
  threadId: "thread_1",
  runId,
  state: {},
  messages,
  tools: [],
  context: [],
  forwardedProps: {},
});

const newAgent = (
  fake: ReturnType<typeof createFakeClient>,
  store: SessionStore,
  extra: Partial<ManagedAgentsAgentConfig> = {},
) =>
  new ManagedAgentsAgent({
    managedAgentId: "agent_1",
    environmentId: "env_1",
    client: fake.client,
    sessionStore: store,
    ...extra,
  });

const collect = async (agent: ManagedAgentsAgent, run: RunAgentInput) =>
  (await lastValueFrom(agent.run(run).pipe(toArray()))).filter(
    (e) => e.type !== EventType.RAW,
  ) as BaseEvent[];

const contentOf = (events: BaseEvent[], messageId: string) =>
  events
    .filter(
      (e) =>
        e.type === EventType.TEXT_MESSAGE_CONTENT &&
        (e as { messageId?: string }).messageId === messageId,
    )
    .map((e) => (e as { delta?: string }).delta);

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
const interrupts = (fake: ReturnType<typeof createFakeClient>) =>
  fake.sent
    .flatMap((send) => send.events)
    .filter((e) => (e as { type?: string }).type === "user.interrupt");

const preview = (id: string, text: string) => [
  { type: "event_start", event: { type: "agent.message", id } },
  {
    type: "event_delta",
    event_id: id,
    delta: { type: "content_delta", index: 0, content: { type: "text", text } },
  },
];

describe("a follow-up turn on an existing thread", () => {
  it("streams previews like a first turn", async () => {
    const store = new InMemorySessionStore();
    const fake = createFakeClient({
      streams: [
        firstTurn,
        [
          ...preview("msg_2", "Sure"),
          {
            type: "agent.message",
            id: "msg_2",
            content: [{ type: "text", text: "Sure thing" }],
          },
          idle("idle_2"),
        ],
      ],
      histories: [[idle("idle_1")]],
    });

    await collect(newAgent(fake, store), input("run_1", [u1]));
    const events = await collect(newAgent(fake, store), input("run_2", [u1, u2]));

    expect(fake.spies.stream.mock.calls[1]![1]).toEqual({
      event_deltas: ["agent.message", "agent.thinking"],
    });
    // The preview arrives first, then the buffered message tops it up.
    expect(contentOf(events, "msg_2")).toEqual(["Sure", " thing"]);
    expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
  });

  it("requests no previews on a follow-up when streamDeltas is false", async () => {
    const store = new InMemorySessionStore();
    const fake = createFakeClient({
      streams: [
        firstTurn,
        [
          ...preview("msg_2", "Sure"),
          {
            type: "agent.message",
            id: "msg_2",
            content: [{ type: "text", text: "Sure thing" }],
          },
          idle("idle_2"),
        ],
      ],
      histories: [[idle("idle_1")]],
    });
    const config = { streamDeltas: false };

    await collect(newAgent(fake, store, config), input("run_1", [u1]));
    const events = await collect(
      newAgent(fake, store, config),
      input("run_2", [u1, u2]),
    );

    expect(fake.spies.stream.mock.calls[1]![1]).toEqual({});
    expect(contentOf(events, "msg_2")).toEqual(["Sure thing"]);
  });

  it("does not preview a message that history already replayed", async () => {
    // msg_late finished after the last run's cursor: recovery replays it whole
    // from history, so its live preview must not be shown a second time.
    const store = new InMemorySessionStore();
    const late = {
      type: "agent.message",
      id: "msg_late",
      content: [{ type: "text", text: "Earlier answer" }],
    };
    const fake = createFakeClient({
      streams: [
        firstTurn,
        [
          ...preview("msg_late", "Earl"),
          late,
          ...preview("msg_2", "Sure"),
          {
            type: "agent.message",
            id: "msg_2",
            content: [{ type: "text", text: "Sure thing" }],
          },
          idle("idle_2"),
        ],
      ],
      histories: [[idle("idle_1"), late]],
    });

    await collect(newAgent(fake, store), input("run_1", [u1]));
    const events = await collect(newAgent(fake, store), input("run_2", [u1, u2]));

    expect(contentOf(events, "msg_late")).toEqual(["Earlier answer"]);
    expect(
      events.filter(
        (e) =>
          e.type === EventType.TEXT_MESSAGE_START &&
          (e as { messageId?: string }).messageId === "msg_late",
      ),
    ).toHaveLength(1);
    expect(contentOf(events, "msg_2")).toEqual(["Sure", " thing"]);
  });

  it("interrupts the session when the client leaves during a follow-up turn", async () => {
    const store = new InMemorySessionStore();
    const fake = createFakeClient({
      streams: [firstTurn, [new Promise<void>(() => {})]],
      histories: [[idle("idle_1")]],
    });

    await collect(newAgent(fake, store), input("run_1", [u1]));
    const received: BaseEvent[] = [];
    const subscription = newAgent(fake, store)
      .run(input("run_2", [u1, u2]))
      .subscribe({ next: (event) => received.push(event) });
    await settle(); // follow-up posted, turn in flight
    expect(fake.sent.at(-1)?.events).toContainEqual({
      type: "user.message",
      content: [{ type: "text", text: "And now?" }],
    });

    subscription.unsubscribe();
    await settle(); // let the interrupt land

    expect(interrupts(fake)).toHaveLength(1);
    expect(received.map((e) => e.type)).not.toContain(EventType.RUN_ERROR);
  });

  it("still leaves a running session alone when a reconnect is abandoned", async () => {
    // A reconnect sends nothing: it watches a turn some earlier run started.
    const store = new InMemorySessionStore();
    const fake = createFakeClient({
      streams: [firstTurn, [new Promise<void>(() => {})]],
      histories: [[idle("idle_1")]],
      sessionStatus: "running",
    });

    await collect(newAgent(fake, store), input("run_1", [u1]));
    const sentBefore = fake.sent.length;
    const subscription = newAgent(fake, store)
      .run(input("run_2", [u1]))
      .subscribe({ next: () => undefined });
    await settle();
    expect(fake.sent).toHaveLength(sentBefore); // nothing new was sent

    subscription.unsubscribe();
    await settle();

    expect(interrupts(fake)).toHaveLength(0);
  });
});

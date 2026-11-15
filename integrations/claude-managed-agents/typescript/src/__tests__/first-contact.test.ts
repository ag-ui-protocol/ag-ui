import { describe, expect, it } from "vitest";
import { EventType, type Message, type RunAgentInput } from "@ag-ui/client";
import { lastValueFrom, toArray } from "rxjs";
import { ManagedAgentsAgent } from "../agent";
import { createFakeClient } from "./fake-client";

const run = async (messages: Message[]) => {
  const fake = createFakeClient({
    streams: [
      [
        {
          type: "session.status_idle",
          id: "idle",
          stop_reason: { type: "end_turn" },
        },
      ],
    ],
  });
  const agent = new ManagedAgentsAgent({
    managedAgentId: "a",
    environmentId: "e",
    client: fake.client,
  });
  const input: RunAgentInput = {
    threadId: "t",
    runId: "r",
    state: {},
    messages,
    tools: [],
    context: [],
    forwardedProps: {},
  };
  const original = structuredClone(input);
  const events = await lastValueFrom(agent.run(input).pipe(toArray()));
  expect(events[0]).toMatchObject({
    type: EventType.RUN_STARTED,
    input: original,
  });
  expect(input).toEqual(original);
  return { fake, events };
};

describe("first-contact attachment preflight", () => {
  it.each(
    ["%%%", "/w=="].flatMap((value) => [
      { value, malformedLast: false },
      { value, malformedLast: true },
    ]),
  )(
    "validates only the newest user message ($value, malformedLast=$malformedLast)",
    async ({ value, malformedLast }) => {
      const malformed: Message = {
        id: "malformed",
        role: "user",
        content: [
          {
            type: "document",
            source: { type: "data", value, mimeType: "text/plain" },
          },
        ],
      };
      const corrected: Message = {
        id: "corrected",
        role: "user",
        content: "corrected message",
      };
      const { fake, events } = await run(
        malformedLast ? [corrected, malformed] : [malformed, corrected],
      );
      if (malformedLast) {
        expect(events.at(-1)?.type).toBe(EventType.RUN_ERROR);
        expect(
          events.filter((event) => event.type === EventType.RUN_ERROR),
        ).toHaveLength(1);
        expect(fake.spies.create).not.toHaveBeenCalled();
        expect(fake.sent).toEqual([]);
      } else {
        expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
        expect(fake.spies.create).toHaveBeenCalledTimes(1);
        expect(fake.sent).toHaveLength(1);
        expect(fake.sent[0].events).toContainEqual({
          type: "user.message",
          content: [{ type: "text", text: "corrected message" }],
        });
      }
    },
  );

  it("does not create a session from older text when the newest user message is blank", async () => {
    const { fake, events } = await run([
      { id: "old", role: "user", content: "older message" },
      { id: "new", role: "user", content: " \n" },
    ]);
    expect(events.at(-1)?.type).toBe(EventType.RUN_ERROR);
    expect(fake.spies.create).not.toHaveBeenCalled();
    expect(fake.sent).toEqual([]);
  });
});

describe("existing-session attachment validation", () => {
  const idle = {
    type: "session.status_idle",
    id: "idle",
    stop_reason: { type: "end_turn" },
  };
  const malformedMessage = (value: string): Message => ({
    id: "malformed",
    role: "user",
    content: [
      {
        type: "document",
        source: { type: "data", value, mimeType: "text/plain" },
      },
    ],
  });
  const corrected: Message = {
    id: "corrected",
    role: "user",
    content: "corrected message",
  };
  const setup = () => {
    const fake = createFakeClient({
      streams: [[idle], [{ ...idle, id: "idle_2" }]],
    });
    const agent = new ManagedAgentsAgent({
      managedAgentId: "a",
      environmentId: "e",
      client: fake.client,
    });
    const runTurn = (messages: Message[], runId: string) =>
      lastValueFrom(
        agent
          .run({
            threadId: "t",
            runId,
            state: {},
            messages,
            tools: [],
            context: [],
            forwardedProps: {},
          })
          .pipe(toArray()),
      );
    return { fake, runTurn };
  };

  it.each(["%%%", "/w=="])(
    "does not revalidate delivered history (%s)",
    async (value) => {
      const { fake, runTurn } = setup();
      const first = await runTurn([malformedMessage(value), corrected], "r1");
      expect(first.at(-1)?.type).toBe(EventType.RUN_FINISHED);
      const events = await runTurn(
        [
          malformedMessage(value),
          corrected,
          { id: "next", role: "user", content: "next message" },
        ],
        "r2",
      );
      expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
      expect(fake.spies.create).toHaveBeenCalledTimes(1);
      expect(
        fake.sent
          .at(-1)
          ?.events.filter(
            (event) => (event as { type: string }).type === "user.message",
          ),
      ).toEqual([
        {
          type: "user.message",
          content: [{ type: "text", text: "next message" }],
        },
      ]);
    },
  );

  it.each(["%%%", "/w=="])(
    "rejects a malformed newest user message (%s)",
    async (value) => {
      const { fake, runTurn } = setup();
      const first = await runTurn([corrected], "r1");
      expect(first.at(-1)?.type).toBe(EventType.RUN_FINISHED);
      const sent = [...fake.sent];
      const events = await runTurn([corrected, malformedMessage(value)], "r2");
      expect(events.at(-1)).toMatchObject({
        type: EventType.RUN_ERROR,
        code: "run_failed",
      });
      expect(fake.sent).toEqual(sent);
    },
  );
});

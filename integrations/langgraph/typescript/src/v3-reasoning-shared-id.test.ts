import { defaultApplyEvents, EventType, verifyEvents } from "@ag-ui/client";
import { firstValueFrom, from, toArray } from "rxjs";
import { describe, expect, it, vi } from "vitest";
import { LangGraphAgent, type ProcessedEvents } from "./agent";
import { aguiTransformer } from "./transformer/agui-transformer";
import { langchainMessagesToAgui } from "./utils";
import type { V3MessageEvent } from "./types";

async function harness(lane: "raw" | "transformer") {
  const events: ProcessedEvents[] = [];
  if (lane === "raw") {
    const agent = new LangGraphAgent({
      graphId: "chat",
      deploymentUrl: "http://localhost:2024",
    });
    agent.activeRun = {
      id: "run",
      threadId: "thread",
      textBlockMessageIds: new Map(),
      toolBlocks: new Map(),
      reasoningBlocks: new Map(),
    };
    agent.dispatchEvent = (event) => {
      events.push(event);
      return true;
    };
    return {
      events,
      send: (data: V3MessageEvent) => agent.handleSingleEventV3(data),
      finish: () => agent.handleSingleEventV3({ event: "message-finish" }),
    };
  }
  const transformer = aguiTransformer();
  const { agui } = await transformer.init();
  vi.spyOn(agui, "push").mockImplementation((event) => {
    events.push(event);
  });
  return {
    events,
    send: (data: V3MessageEvent) =>
      transformer.process({
        type: "event",
        seq: 0,
        method: "messages",
        params: { namespace: [], timestamp: 0, data },
      }),
    finish: () => transformer.finalize?.(),
  };
}

async function applyVerified(events: ProcessedEvents[]) {
  const input = {
    threadId: "thread",
    runId: "run",
    messages: [],
    state: {},
    tools: [],
    context: [],
  };
  const agent = new LangGraphAgent({
    graphId: "chat",
    deploymentUrl: "http://localhost:2024",
  });
  const complete: ProcessedEvents[] = [
    { type: EventType.RUN_STARTED, threadId: "thread", runId: "run" },
    ...events,
    { type: EventType.RUN_FINISHED, threadId: "thread", runId: "run" },
  ];
  return firstValueFrom(
    defaultApplyEvents(
      input,
      from(complete).pipe(verifyEvents()),
      agent,
      [],
    ).pipe(toArray()),
  );
}

describe.each(["raw", "transformer"] as const)(
  "%s shared reasoning IDs",
  (lane) => {
    it.each([false, true])(
      "balances overlapping blocks, partial close %s",
      async (partial) => {
        const h = await harness(lane);
        h.send({ event: "message-start", id: "answer" });
        for (const index of [0, 1])
          h.send({
            event: "content-block-start",
            index,
            content: {
              type: "reasoning",
              id: "rs_same",
              reasoning: index === 0 ? "First" : "Second",
            },
          });
        expect(
          h.events.filter((e) => e.type === "REASONING_START"),
        ).toHaveLength(1);
        expect(
          h.events.filter((e) => e.type === "REASONING_MESSAGE_START"),
        ).toHaveLength(1);
        if (partial) {
          h.send({
            event: "content-block-finish",
            index: 0,
            content: { type: "reasoning" },
          });
          expect(
            h.events.filter((e) => e.type === "REASONING_END"),
          ).toHaveLength(0);
          h.send({
            event: "content-block-delta",
            index: 1,
            delta: { type: "reasoning-delta", reasoning: "Tail" },
          });
        }
        h.finish();
        await applyVerified(h.events);
        expect(h.events.filter((e) => e.type === "REASONING_END")).toEqual([
          { type: "REASONING_END", messageId: "rs_same" },
        ]);
        expect(
          h.events.filter((e) => e.type === "REASONING_MESSAGE_END"),
        ).toHaveLength(1);
        expect(
          h.events.flatMap((e) =>
            e.type === "REASONING_MESSAGE_CONTENT" ? [e.delta] : [],
          ),
        ).toEqual(partial ? ["First", "Second", "Tail"] : ["First", "Second"]);
      },
    );
    it("balances empty repeated IDs on message error", async () => {
      const h = await harness(lane);
      h.send({ event: "message-start", id: "answer" });
      for (const index of [0, 1])
        h.send({
          event: "content-block-start",
          index,
          content: { type: "reasoning", id: "rs_same" },
        });
      h.send({ event: "message-error" });
      h.finish();
      await applyVerified(h.events);
      expect(h.events.filter((e) => e.type === "REASONING_START")).toHaveLength(
        1,
      );
      expect(h.events.filter((e) => e.type === "REASONING_END")).toHaveLength(
        1,
      );
      expect(
        h.events.filter((e) => e.type === "REASONING_MESSAGE_START"),
      ).toHaveLength(0);
    });

    it("appends sequential summaries to the same client message and reconciles its snapshot", async () => {
      const h = await harness(lane);
      h.send({ event: "message-start", id: "answer" });
      for (const [index, reasoning] of ["First", "Second"].entries()) {
        h.send({
          event: "content-block-start",
          index,
          content: { type: "reasoning", id: "rs_same", reasoning },
        });
        h.send({
          event: "content-block-finish",
          index,
          content: { type: "reasoning" },
        });
      }
      h.finish();
      const updates = await applyVerified(h.events);
      expect(
        updates
          .flatMap((update) => update.messages ?? [])
          .filter((message) => message.id === "rs_same")
          .at(-1),
      ).toMatchObject({ content: "FirstSecond" });
      const snapshot = langchainMessagesToAgui([
        {
          type: "ai",
          id: "answer",
          content: [
            // @ts-expect-error SDK MessageContent omits provider reasoning blocks accepted on the wire.
            { type: "reasoning", id: "rs_same", reasoning: "First" },
            {
              // @ts-expect-error SDK MessageContent omits provider reasoning blocks accepted on the wire.
              type: "reasoning",
              id: "rs_same",
              reasoning: "Second",
              encrypted_content: "encrypted",
            },
          ],
        },
      ]);
      const reconciled = await applyVerified([
        ...h.events,
        { type: EventType.MESSAGES_SNAPSHOT, messages: snapshot },
      ]);
      expect(
        reconciled
          .at(-1)
          ?.messages?.filter((message) => message.role === "reasoning"),
      ).toEqual([
        {
          id: "rs_same",
          role: "reasoning",
          content: "First\nSecond",
          encryptedValue: "encrypted",
        },
      ]);
    });
  },
);

it("reconciles repeated provider IDs into one complete snapshot message", () => {
  expect(
    langchainMessagesToAgui([
      {
        type: "ai",
        id: "answer",
        content: [
          {
            // @ts-expect-error SDK MessageContent omits provider reasoning blocks accepted on the wire.
            type: "reasoning",
            id: "rs_same",
            summary: [{ type: "summary_text", text: "First" }],
          },
          {
            // @ts-expect-error SDK MessageContent omits provider reasoning blocks accepted on the wire.
            type: "reasoning",
            id: "rs_same",
            summary: [{ type: "summary_text", text: "Second" }],
            encrypted_content: "encrypted",
          },
        ],
      },
    ]),
  ).toEqual([
    {
      id: "rs_same",
      role: "reasoning",
      content: "First\nSecond",
      encryptedValue: "encrypted",
    },
    { id: "answer", role: "assistant", content: "", toolCalls: undefined },
  ]);
});

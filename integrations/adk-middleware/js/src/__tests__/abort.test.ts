import { createRequire } from "node:module";
import { EventType } from "@ag-ui/core";
import { InMemorySessionService, Runner, createEvent } from "@google/adk";
import { describe, expect, it, vi } from "vitest";

import { ADKJSAgent } from "../index";
import { MessageSnapshot } from "../message-snapshot";
import {
  ScriptedAgent,
  collect,
  runInput,
  textEvent,
  verified,
} from "./helpers";

const { version: adkVersion }: { version: string } = createRequire(
  import.meta.url,
)("@google/adk/package.json");
const [adkMajor, adkMinor] = adkVersion.split(".").map(Number);
const sealsPendingCalls = adkMajor === 2 && adkMinor >= 3;

describe("ADKJSAgent abort", () => {
  it.each([
    { errorCode: "INVOCATION_ABORTED", stopped: true },
    { errorCode: "INVOCATION_ABORTED", stopped: false },
    { errorCode: "MODEL_ERROR", stopped: true },
  ])(
    "handles $errorCode with local stop=$stopped",
    async ({ errorCode, stopped }) => {
      const runner = new Runner({
        appName: "test-app",
        sessionService: new InMemorySessionService(),
        agent: new ScriptedAgent(() => []),
      });
      const bridge = new ADKJSAgent({ runner, userId: "user-1" });
      let drained = false;
      // Simulate the new runner events even with the minimum ADK version.
      vi.spyOn(runner, "runAsync").mockImplementation(async function* () {
        if (stopped) {
          bridge.abortRun();
        }
        for (const id of ["error-1", "error-2"]) {
          yield createEvent({ id, author: "scripted_agent", errorCode });
        }
        drained = true;
      });

      const events = await collect(bridge, runInput());

      if (stopped && errorCode === "INVOCATION_ABORTED") {
        expect(events.at(-1)).toMatchObject({
          type: EventType.RUN_FINISHED,
          outcome: { type: "cancelled" },
        });
        expect(drained).toBe(true);
      } else {
        expect(events.at(-1)).toMatchObject({
          type: EventType.RUN_ERROR,
          code: errorCode,
        });
      }
      await verified(events);
    },
  );

  it("closes a deliberate stop with the cancelled outcome, not RUN_ERROR", async () => {
    const bridge = new ADKJSAgent({
      userId: "user-1",
      runner: new Runner({
        appName: "test-app",
        sessionService: new InMemorySessionService(),
        agent: new ScriptedAgent(async (context) => {
          await new Promise<void>((resolve) => {
            context.abortSignal?.addEventListener("abort", () => resolve(), {
              once: true,
            });
          });
          return [];
        }),
      }),
    });

    const result = collect(bridge, runInput());
    await new Promise((resolve) => setTimeout(resolve, 5));
    bridge.abortRun();
    const events = await result;

    expect(
      events.filter((event) => event.type === EventType.RUN_ERROR),
    ).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({
      type: EventType.RUN_FINISHED,
      outcome: { type: "cancelled" },
    });
    expect(events.at(-1)).not.toHaveProperty("result");
    await verified(events);
  });

  it("propagates stream unsubscription as an ADK abort and releases the thread", async () => {
    let execution = 0;
    let signalStarted!: () => void;
    let abortObserved!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const aborted = new Promise<void>((resolve) => {
      abortObserved = resolve;
    });
    const bridge = new ADKJSAgent({
      userId: "user-1",
      runner: new Runner({
        appName: "test-app",
        sessionService: new InMemorySessionService(),
        agent: new ScriptedAgent(async (context) => {
          execution += 1;
          if (execution > 1) {
            return [textEvent({ id: "after-disconnect", text: "available" })];
          }
          signalStarted();
          await new Promise<void>((resolve) => {
            context.abortSignal?.addEventListener(
              "abort",
              () => {
                abortObserved();
                resolve();
              },
              { once: true },
            );
          });
          return [];
        }),
      }),
    });

    const subscription = bridge.run(runInput()).subscribe();
    await started;
    subscription.unsubscribe();
    await aborted;
    // Unsubscribing gives no completion signal, so poll until the thread is free.
    const nextInput = runInput({
      runId: "run-2",
      messages: [{ id: "user-2", role: "user", content: "Again" }],
    });
    let next: Awaited<ReturnType<typeof collect>> = [];
    await expect
      .poll(
        async () => {
          next = await collect(bridge, nextInput);
          return next.at(-1)?.type;
        },
        { timeout: 1000 },
      )
      .toBe(EventType.RUN_FINISHED);
    expect(next.at(-1)).toMatchObject({
      type: EventType.RUN_FINISHED,
      outcome: { type: "success" },
    });
  });

  it("does not report a sub-agent as finished when the run is aborted", async () => {
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const child = new ScriptedAgent(() => [], { name: "child" });
    const root = new ScriptedAgent(
      async function* (context) {
        yield createEvent({
          id: "child-partial",
          author: "child",
          partial: true,
          content: { role: "model", parts: [{ text: "working" }] },
        });
        signalStarted();
        await new Promise<void>((resolve) => {
          context.abortSignal?.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
      },
      { name: "root", subAgents: [child] },
    );
    const bridge = new ADKJSAgent({
      userId: "user-1",
      subagents: "attributed",
      runner: new Runner({
        appName: "test-app",
        sessionService: new InMemorySessionService(),
        agent: root,
      }),
    });

    const result = collect(bridge, runInput());
    await started;
    bridge.abortRun();
    const events = await result;

    const types = events.map((event) => event.type);
    expect(types).toContain(EventType.SUBAGENT_STARTED);
    expect(types).not.toContain(EventType.SUBAGENT_FINISHED);
    // Sub-agent open: no cancelled variant, so RUN_ERROR.
    expect(events.at(-1)).toMatchObject({
      type: EventType.RUN_ERROR,
      code: "ABORTED",
    });
    await verified(events);
  });

  it.each(["off", "attributed"] as const)(
    "preserves pending tool history across cancellation and a new turn (subagents=%s)",
    async (subagents) => {
      let signalStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        signalStarted = resolve;
      });
      let execution = 0;
      const sessionService = new InMemorySessionService();
      const authors =
        subagents === "attributed"
          ? ["scripted_agent", "child"]
          : ["scripted_agent"];
      const expectedCalls = authors.map((author) => `${author}-tool`);
      const root = new ScriptedAgent(
        async function* (context) {
          if (++execution > 1) {
            yield textEvent({ id: "next-answer", text: "available" });
            return;
          }
          // In attributed mode, ADK 2.3 persists one abort event per author.
          for (const author of authors) {
            yield createEvent({
              id: `${author}-call`,
              invocationId: context.invocationId,
              author,
              content: {
                role: "model",
                parts: [
                  {
                    functionCall: {
                      id: `${author}-tool`,
                      name: "lookup",
                      args: {},
                    },
                  },
                ],
              },
            });
          }
          signalStarted();
          await new Promise<void>((resolve) => {
            context.abortSignal?.addEventListener("abort", () => resolve(), {
              once: true,
            });
          });
        },
        { subAgents: [new ScriptedAgent(() => [], { name: "child" })] },
      );
      const bridge = new ADKJSAgent({
        userId: "user-1",
        subagents,
        runner: new Runner({
          appName: "test-app",
          sessionService,
          agent: root,
        }),
      });
      const input = runInput();
      const result = collect(bridge, input);
      await started;
      bridge.abortRun();
      const events = await result;

      expect(events.at(-1)).toMatchObject(
        subagents === "attributed"
          ? { type: EventType.RUN_ERROR, code: "ABORTED" }
          : { type: EventType.RUN_FINISHED, outcome: { type: "cancelled" } },
      );
      expect(events.map((event) => event.type)).not.toContain(
        EventType.SUBAGENT_FINISHED,
      );
      expect(events.map((event) => event.type)).not.toContain(
        EventType.TOOL_CALL_RESULT,
      );
      await verified(events);

      const sessionParams = {
        appName: "test-app",
        userId: "user-1",
        sessionId: input.threadId,
      };
      const session = await sessionService.getSession(sessionParams);
      const abortEvents = session!.events.filter(
        (event) => event.errorCode === "INVOCATION_ABORTED",
      );
      const responses = abortEvents.flatMap((event) =>
        (event.content?.parts ?? []).flatMap((part) =>
          part.functionResponse ? [part.functionResponse] : [],
        ),
      );
      // Older ADK leaves calls unanswered; 2.3 seals every pending call.
      expect(abortEvents).toHaveLength(sealsPendingCalls ? authors.length : 0);
      expect(responses.map((response) => response.id).sort()).toEqual(
        sealsPendingCalls ? [...expectedCalls].sort() : [],
      );
      for (const response of responses) {
        expect(response).toMatchObject({
          name: "lookup",
          response: { error: "Invocation was aborted by client." },
        });
      }

      const snapshot = new MessageSnapshot(input.messages);
      for (const event of events) {
        snapshot.apply(event);
      }
      const next = await collect(
        bridge,
        runInput({
          runId: "run-2",
          messages: [
            ...snapshot.getMessages(),
            { id: "user-2", role: "user", content: "Again" },
          ],
        }),
      );
      expect(next.at(-1)).toMatchObject({
        type: EventType.RUN_FINISHED,
        outcome: { type: "success" },
      });
      await verified(next);
      const latest = await sessionService.getSession(sessionParams);
      expect(
        latest!.events.flatMap((event) =>
          (event.content?.parts ?? []).flatMap((part) =>
            part.functionCall ? [part.functionCall.id] : [],
          ),
        ),
      ).toEqual(expectedCalls);
      expect(
        latest!.events.filter(
          (event) => event.errorCode === "INVOCATION_ABORTED",
        ),
      ).toEqual(abortEvents);
    },
  );
});

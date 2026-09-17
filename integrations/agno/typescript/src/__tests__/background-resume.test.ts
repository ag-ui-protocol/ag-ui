/**
 * A background AgnoAgent must survive a dropped stream: it reconnects to the
 * same run, tells the server the last cursor it saw, and hands its subscriber
 * one unbroken sequence. Against a server that does not support background
 * runs it must behave exactly like a plain HttpAgent.
 *
 * Most cases drive the whole agent through runAgent so the protocol verifier
 * sees the stitched stream, which is the thing a client actually consumes.
 */
import { describe, it, expect, vi } from "vitest";
import { EventType, type BaseEvent, type RunAgentInput } from "@ag-ui/core";
import { firstValueFrom, toArray } from "rxjs";
import { AGNO_BACKGROUND_KEY, AgnoAgent } from "../index";

type Cursor = { eventIndex: number; subIndex: number };

interface StreamEvent {
  event: Record<string, unknown>;
  cursor: Cursor;
}

function marked(
  event: Record<string, unknown>,
  eventIndex: number,
  subIndex = 0,
): StreamEvent {
  return {
    event: {
      ...event,
      metadata: { [AGNO_BACKGROUND_KEY]: { eventIndex, subIndex } },
    },
    cursor: { eventIndex, subIndex },
  };
}

const DELTAS = ["one ", "two ", "three ", "four ", "five"];

function backgroundRun(
  threadId: string,
  runId: string,
  terminal = EventType.RUN_FINISHED,
) {
  const events: StreamEvent[] = [
    marked({ type: EventType.RUN_STARTED, threadId, runId }, -1),
    marked(
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "m1",
        role: "assistant",
      },
      0,
    ),
  ];
  DELTAS.forEach((delta, position) => {
    events.push(
      marked(
        { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta },
        position + 1,
      ),
    );
  });
  events.push(
    marked(
      { type: EventType.TEXT_MESSAGE_END, messageId: "m1" },
      DELTAS.length + 1,
    ),
  );
  events.push(
    terminal === EventType.RUN_FINISHED
      ? marked(
          { type: EventType.RUN_FINISHED, threadId, runId },
          DELTAS.length + 2,
        )
      : marked(
          { type: EventType.RUN_ERROR, message: "the run failed" },
          DELTAS.length + 2,
        ),
  );
  return events;
}

function sseBody(events: StreamEvent[]): string {
  return events
    .map(({ event }) => `data: ${JSON.stringify(event)}\n\n`)
    .join("");
}

function sseResponse(events: StreamEvent[]): Response {
  return new Response(sseBody(events), {
    headers: { "Content-Type": "text/event-stream" },
  });
}

function requestedCursor(input: RunAgentInput): Cursor | undefined {
  const props = (input.forwardedProps as Record<string, any> | undefined)?.[
    AGNO_BACKGROUND_KEY
  ];
  if (props?.lastEventIndex === undefined) return undefined;
  return { eventIndex: props.lastEventIndex, subIndex: props.lastSubIndex };
}

function after(
  events: StreamEvent[],
  cursor: Cursor | undefined,
): StreamEvent[] {
  if (cursor === undefined) return events;
  return events.filter(
    ({ cursor: c }) =>
      c.eventIndex > cursor.eventIndex ||
      (c.eventIndex === cursor.eventIndex && c.subIndex > cursor.subIndex),
  );
}

/**
 * A server that truncates each response after `perAttempt` events until the
 * run has been served `dropCount` times, then serves the remainder.
 */
function createResumingServer(
  perAttempt: number,
  dropCount = 1,
  terminal = EventType.RUN_FINISHED,
) {
  const requests: RunAgentInput[] = [];
  let served = 0;
  const fetch = async (_url: string, requestInit: RequestInit) => {
    const input = JSON.parse(requestInit.body as string) as RunAgentInput;
    requests.push(input);
    const remaining = after(
      backgroundRun(input.threadId, input.runId, terminal),
      requestedCursor(input),
    );
    served += 1;
    return sseResponse(
      served <= dropCount ? remaining.slice(0, perAttempt) : remaining,
    );
  };
  return { fetch, requests };
}

/** A server that ignores the background request entirely. */
function createLegacyServer(truncateAfter?: number) {
  const requests: RunAgentInput[] = [];
  const fetch = async (_url: string, requestInit: RequestInit) => {
    const input = JSON.parse(requestInit.body as string) as RunAgentInput;
    requests.push(input);
    const plain = backgroundRun(input.threadId, input.runId).map(
      ({ event, cursor }) => {
        const { metadata: _metadata, ...rest } = event;
        return { event: rest, cursor };
      },
    );
    return sseResponse(
      truncateAfter === undefined ? plain : plain.slice(0, truncateAfter),
    );
  };
  return { fetch, requests };
}

function makeAgent(
  fetch: any,
  background: boolean,
  overrides: Record<string, unknown> = {},
) {
  return new AgnoAgent({
    url: "http://agno.invalid/agui",
    background,
    reconnectDelayMs: 0,
    initialMessages: [{ id: "u1", role: "user", content: "count to five" }],
    fetch,
    ...overrides,
  });
}

function inputFor(runId: string): RunAgentInput {
  return {
    threadId: "t1",
    runId,
    state: {},
    messages: [{ id: "u1", role: "user", content: "count to five" }],
    tools: [],
    context: [],
    forwardedProps: {},
  } as RunAgentInput;
}

async function runToArray(
  agent: AgnoAgent,
  input: RunAgentInput,
): Promise<BaseEvent[]> {
  return firstValueFrom(agent.run(input).pipe(toArray()));
}

function backgroundPropsOf(input: RunAgentInput): Record<string, unknown> {
  return (input.forwardedProps as Record<string, any>)[AGNO_BACKGROUND_KEY];
}

describe("AgnoAgent background runs", () => {
  it("does not ask for a background run unless configured for one", async () => {
    const server = createLegacyServer();
    const agent = makeAgent(server.fetch, false);

    await agent.runAgent();

    expect(server.requests).toHaveLength(1);
    expect(
      (server.requests[0]!.forwardedProps as any)[AGNO_BACKGROUND_KEY],
    ).toBeUndefined();
  });

  it("asks for a background run when configured for one", async () => {
    const server = createResumingServer(99, 0);
    const agent = makeAgent(server.fetch, true);

    await agent.runAgent();

    expect(backgroundPropsOf(server.requests[0]!)).toEqual({ enabled: true });
  });

  it("keeps a caller's own background settings when adding the cursor", async () => {
    const server = createResumingServer(3);
    const agent = makeAgent(server.fetch, true);
    const input = inputFor("r1");
    input.forwardedProps = {
      user_id: "u9",
      [AGNO_BACKGROUND_KEY]: { note: "kept" },
    };

    await runToArray(agent, input);

    expect(server.requests[1]!.forwardedProps).toMatchObject({ user_id: "u9" });
    expect(backgroundPropsOf(server.requests[1]!)).toEqual({
      note: "kept",
      enabled: true,
      lastEventIndex: 1,
      lastSubIndex: 0,
    });
  });

  it("delivers one unbroken run through the whole agent pipeline", async () => {
    const server = createResumingServer(3);
    const agent = makeAgent(server.fetch, true);

    const result = await agent.runAgent();

    expect(server.requests).toHaveLength(2);
    expect(server.requests[1]!.runId).toBe(server.requests[0]!.runId);
    const assistant = result.newMessages.find(
      (message) => message.role === "assistant",
    );
    expect(assistant?.content).toBe(DELTAS.join(""));
  });

  it("resumes from the last cursor it received", async () => {
    const server = createResumingServer(3);
    const agent = makeAgent(server.fetch, true);

    await runToArray(agent, inputFor("r1"));

    expect(backgroundPropsOf(server.requests[1]!)).toEqual({
      enabled: true,
      lastEventIndex: 1,
      lastSubIndex: 0,
    });
  });

  it("strips the resume marker before handing the event on", async () => {
    const server = createResumingServer(3);
    const agent = makeAgent(server.fetch, true);

    const events = await runToArray(agent, inputFor("r1"));

    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(
        (event.metadata as Record<string, unknown> | undefined)?.[
          AGNO_BACKGROUND_KEY
        ],
      ).toBeUndefined();
    }
  });

  it("keeps reconnecting across more drops than its budget, because each one makes progress", async () => {
    const server = createResumingServer(2, 8);
    const agent = makeAgent(server.fetch, true, { maxReconnectAttempts: 2 });

    const result = await agent.runAgent();

    expect(server.requests.length).toBeGreaterThan(3);
    const assistant = result.newMessages.find(
      (message) => message.role === "assistant",
    );
    expect(assistant?.content).toBe(DELTAS.join(""));
  });

  it("gives up once reconnects stop making progress", async () => {
    const requests: RunAgentInput[] = [];
    let served = 0;
    const fetch = async (_url: string, requestInit: RequestInit) => {
      const input = JSON.parse(requestInit.body as string) as RunAgentInput;
      requests.push(input);
      const remaining = after(
        backgroundRun(input.threadId, input.runId),
        requestedCursor(input),
      );
      served += 1;
      // The first attempt makes progress; every reconnect after it delivers
      // nothing, which is what the budget exists to stop.
      return sseResponse(served === 1 ? remaining.slice(0, 3) : []);
    };
    const agent = makeAgent(fetch, true, { maxReconnectAttempts: 2 });

    await expect(runToArray(agent, inputFor("r1"))).rejects.toThrow(
      /the stream ended before the run finished/,
    );
    expect(requests).toHaveLength(4);
  });

  it("does not reconnect to a server that ignored the background request", async () => {
    const server = createLegacyServer(3);
    const agent = makeAgent(server.fetch, true);

    await expect(runToArray(agent, inputFor("r1"))).rejects.toThrow(
      /the stream ended before the run finished/,
    );
    expect(server.requests).toHaveLength(1);
  });

  it("streams a whole run from a server that ignored the background request", async () => {
    const server = createLegacyServer();
    const agent = makeAgent(server.fetch, true);

    const events = await runToArray(agent, inputFor("r1"));

    expect(server.requests).toHaveLength(1);
    expect(events[events.length - 1]!.type).toBe(EventType.RUN_FINISHED);
  });

  it("treats a server error as the end of the run", async () => {
    const server = createResumingServer(3, 1, EventType.RUN_ERROR);
    const agent = makeAgent(server.fetch, true);

    const events = await runToArray(agent, inputFor("r1"));

    expect(server.requests).toHaveLength(2);
    expect(events[events.length - 1]).toMatchObject({
      type: EventType.RUN_ERROR,
      message: "the run failed",
    });
  });

  it("reconnects when the transport reports the connection was cut", async () => {
    const requests: RunAgentInput[] = [];
    let served = 0;
    const fetch = async (_url: string, requestInit: RequestInit) => {
      const input = JSON.parse(requestInit.body as string) as RunAgentInput;
      requests.push(input);
      const remaining = after(
        backgroundRun(input.threadId, input.runId),
        requestedCursor(input),
      );
      served += 1;
      if (served > 1) {
        return sseResponse(remaining);
      }
      // What the client transport emits for a cancelled fetch: a RUN_ERROR
      // carrying the abort code, then a clean close.
      // No metadata on it: that is what marks it as the transport's own report
      // of a lost socket rather than something the server placed.
      const cut = {
        type: EventType.RUN_ERROR,
        message: "aborted",
        code: "abort",
      };
      return sseResponse([
        ...remaining.slice(0, 3),
        { event: cut, cursor: { eventIndex: -1, subIndex: 0 } },
      ]);
    };
    const agent = makeAgent(fetch, true);

    const events = await runToArray(agent, inputFor("r1"));

    expect(requests).toHaveLength(2);
    expect(events[events.length - 1]!.type).toBe(EventType.RUN_FINISHED);
  });

  it("drops events a server replays inclusively", async () => {
    const requests: RunAgentInput[] = [];
    let served = 0;
    const fetch = async (_url: string, requestInit: RequestInit) => {
      const input = JSON.parse(requestInit.body as string) as RunAgentInput;
      requests.push(input);
      const all = backgroundRun(input.threadId, input.runId);
      const cursor = requestedCursor(input);
      served += 1;
      if (served === 1) {
        return sseResponse(all.slice(0, 3));
      }
      // Inclusive of the cursor rather than after it, so the client has to
      // recognize the overlap itself.
      const start = all.findIndex(
        ({ cursor: c }) =>
          cursor !== undefined && c.eventIndex === cursor.eventIndex,
      );
      if (start < 0) {
        throw new Error(
          `no event at the requested cursor ${JSON.stringify(cursor)}`,
        );
      }
      return sseResponse(all.slice(start));
    };
    const agent = makeAgent(fetch, true);

    const result = await agent.runAgent();

    const assistant = result.newMessages.find(
      (message) => message.role === "assistant",
    );
    expect(assistant?.content).toBe(DELTAS.join(""));
  });

  it("ignores a cursor that would rewind the resume point", async () => {
    const requests: RunAgentInput[] = [];
    let served = 0;
    const fetch = async (_url: string, requestInit: RequestInit) => {
      const input = JSON.parse(requestInit.body as string) as RunAgentInput;
      requests.push(input);
      const all = backgroundRun(input.threadId, input.runId);
      served += 1;
      if (served === 1) {
        // A stale marker arrives after a newer one.
        return sseResponse([
          ...all.slice(0, 4),
          marked({ type: EventType.CUSTOM, name: "late", value: 1 }, 0),
        ]);
      }
      return sseResponse(after(all, requestedCursor(input)));
    };
    const agent = makeAgent(fetch, true);

    await runToArray(agent, inputFor("r1"));

    expect(backgroundPropsOf(requests[1]!)).toMatchObject({
      lastEventIndex: 2,
    });
  });

  it("does not connect at all once the run is aborted", async () => {
    const server = createResumingServer(3);
    const agent = makeAgent(server.fetch, true);
    agent.abortRun();

    const events = await runToArray(agent, inputFor("r1"));

    // The same shape a plain HttpAgent produces for an abort, so one user
    // action does not settle differently depending on its timing.
    expect(events).toEqual([
      expect.objectContaining({ type: EventType.RUN_ERROR, code: "abort" }),
    ]);
    expect(server.requests).toHaveLength(0);
  });

  it("stops reconnecting when the run is aborted during the retry delay", async () => {
    const server = createResumingServer(3, 99);
    // Long enough that settling can only come from noticing the abort, not
    // from the retry timer coming round.
    const agent = makeAgent(server.fetch, true, { reconnectDelayMs: 5_000 });

    const settled: string[] = [];
    const seen: BaseEvent[] = [];
    const subscription = agent.run(inputFor("r1")).subscribe({
      next: (event) => seen.push(event),
      error: (error: Error) => settled.push(`error: ${error.message}`),
      complete: () => settled.push("complete"),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    agent.abortRun();
    await new Promise((resolve) => setTimeout(resolve, 50));
    subscription.unsubscribe();

    // Settling matters as much as not reconnecting: a run that neither errors
    // nor completes leaves its caller waiting forever.
    expect(settled).toEqual(["complete"]);
    expect(seen[seen.length - 1]).toMatchObject({
      type: EventType.RUN_ERROR,
      code: "abort",
    });
    expect(server.requests).toHaveLength(1);
  });

  it("does not hand the transport's dropped-connection error to its subscriber", async () => {
    const requests: RunAgentInput[] = [];
    let served = 0;
    const fetch = async (_url: string, requestInit: RequestInit) => {
      const input = JSON.parse(requestInit.body as string) as RunAgentInput;
      requests.push(input);
      const remaining = after(
        backgroundRun(input.threadId, input.runId),
        requestedCursor(input),
      );
      served += 1;
      if (served > 1) {
        return sseResponse(remaining);
      }
      // No metadata on it: that is what marks it as the transport's own report
      // of a lost socket rather than something the server placed.
      const cut = {
        type: EventType.RUN_ERROR,
        message: "aborted",
        code: "abort",
      };
      return sseResponse([
        ...remaining.slice(0, 3),
        { event: cut, cursor: { eventIndex: -1, subIndex: 0 } },
      ]);
    };
    const agent = makeAgent(fetch, true);

    // Through runAgent, so the protocol verifier sees the stitched stream and
    // would reject every resumed event if the cut reached it as a run error.
    const result = await agent.runAgent();

    expect(requests).toHaveLength(2);
    const assistant = result.newMessages.find(
      (message) => message.role === "assistant",
    );
    expect(assistant?.content).toBe(DELTAS.join(""));
  });

  it("refuses rather than report a run whose events it had to drop", async () => {
    const requests: RunAgentInput[] = [];
    let served = 0;
    const fetch = async (_url: string, requestInit: RequestInit) => {
      const input = JSON.parse(requestInit.body as string) as RunAgentInput;
      requests.push(input);
      const all = backgroundRun(input.threadId, input.runId);
      served += 1;
      if (served === 1) {
        return sseResponse(all.slice(0, 3));
      }
      // Nothing on this leg carries a cursor, so none of it can be placed.
      // Reporting the run as finished would stand behind content that was
      // dropped, and reconnecting would replay the same unplaceable leg
      // forever, so the run has to stop and say so.
      return sseResponse(
        after(all, requestedCursor(input)).map(({ event, cursor }) => {
          const { metadata: _metadata, ...rest } = event;
          return { event: rest, cursor };
        }),
      );
    };
    const agent = makeAgent(fetch, true, { maxReconnectAttempts: 2 });

    await expect(runToArray(agent, inputFor("r1"))).rejects.toThrow(
      /stopped placing its events/,
    );
    expect(requests).toHaveLength(2);
  });

  it("drops an event a resumed leg cannot place, wherever it sits", async () => {
    const requests: RunAgentInput[] = [];
    let served = 0;
    const fetch = async (_url: string, requestInit: RequestInit) => {
      const input = JSON.parse(requestInit.body as string) as RunAgentInput;
      requests.push(input);
      const all = backgroundRun(input.threadId, input.runId);
      served += 1;
      if (served === 1) {
        return sseResponse(all.slice(0, 3));
      }
      const unmarked = {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "m1",
        delta: "again ",
      };
      // At the head of the leg, before anything stamped: the guard must not
      // depend on having seen a cursor first.
      return sseResponse([
        { event: unmarked, cursor: { eventIndex: 0, subIndex: 0 } },
        ...after(all, requestedCursor(input)),
      ]);
    };
    const agent = makeAgent(fetch, true, { maxReconnectAttempts: 1 });

    await expect(runToArray(agent, inputFor("r1"))).rejects.toThrow(
      /stopped placing its events/,
    );
    expect(requests).toHaveLength(2);
  });

  it("keeps two runs of one agent from disturbing each other", async () => {
    // Each run gets its own drop count, so one finishing cannot stand in for
    // the other having been served.
    const servedPerRun = new Map<string, number>();
    const fetch = async (_url: string, requestInit: RequestInit) => {
      const input = JSON.parse(requestInit.body as string) as RunAgentInput;
      const served = (servedPerRun.get(input.runId) ?? 0) + 1;
      servedPerRun.set(input.runId, served);
      const remaining = after(
        backgroundRun(input.threadId, input.runId),
        requestedCursor(input),
      );
      return sseResponse(served === 1 ? remaining.slice(0, 3) : remaining);
    };
    const agent = makeAgent(fetch, true, { reconnectDelayMs: 30 });

    const first = firstValueFrom(agent.run(inputFor("r1")).pipe(toArray()));
    const second = firstValueFrom(agent.run(inputFor("r2")).pipe(toArray()));

    const [firstEvents, secondEvents] = await Promise.all([first, second]);

    expect(servedPerRun.get("r1")).toBe(2);
    expect(servedPerRun.get("r2")).toBe(2);
    expect(firstEvents[firstEvents.length - 1]!.type).toBe(
      EventType.RUN_FINISHED,
    );
    expect(secondEvents[secondEvents.length - 1]!.type).toBe(
      EventType.RUN_FINISHED,
    );
  });

  it("keeps the caller's own event metadata when it strips the marker", async () => {
    const fetch = async (_url: string, requestInit: RequestInit) => {
      const input = JSON.parse(requestInit.body as string) as RunAgentInput;
      const all = backgroundRun(input.threadId, input.runId).map(
        ({ event, cursor }) => ({
          event: {
            ...event,
            metadata: { ...(event.metadata as object), source: "server" },
          },
          cursor,
        }),
      );
      return sseResponse(all);
    };
    const agent = makeAgent(fetch, true);

    const events = await runToArray(agent, inputFor("r1"));

    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event.metadata).toEqual({ source: "server" });
    }
  });

  it("ends an abort that lands mid attempt the same way as any other", async () => {
    let release: (() => void) | undefined;
    const fetch = async (_url: string, requestInit: RequestInit) => {
      const input = JSON.parse(requestInit.body as string) as RunAgentInput;
      const all = backgroundRun(input.threadId, input.runId);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return sseResponse(all.slice(0, 3));
    };
    const agent = makeAgent(fetch, true, { reconnectDelayMs: 5 });

    const settled: string[] = [];
    const seen: BaseEvent[] = [];
    const subscription = agent.run(inputFor("r1")).subscribe({
      next: (event) => seen.push(event),
      error: (error: Error) => settled.push(`error: ${error.message}`),
      complete: () => settled.push("complete"),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    agent.abortRun();
    release?.();
    await new Promise((resolve) => setTimeout(resolve, 100));
    subscription.unsubscribe();

    expect(settled).toEqual(["complete"]);
    expect(seen[seen.length - 1]).toMatchObject({
      type: EventType.RUN_ERROR,
      code: "abort",
    });
  });

  it("stops reconnecting when the subscriber unsubscribes during the retry delay", async () => {
    const server = createResumingServer(3, 99);
    const agent = makeAgent(server.fetch, true, { reconnectDelayMs: 50 });

    const subscription = agent
      .run(inputFor("r1"))
      .subscribe({ error: () => {} });
    await new Promise((resolve) => setTimeout(resolve, 10));
    subscription.unsubscribe();
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(server.requests).toHaveLength(1);
  });

  it("does not reconnect at all when the budget is zero", async () => {
    const server = createResumingServer(3, 99);
    const agent = makeAgent(server.fetch, true, { maxReconnectAttempts: 0 });

    await expect(runToArray(agent, inputFor("r1"))).rejects.toThrow();
    expect(server.requests).toHaveLength(1);
  });

  it("does not resume from the position a run ended at", async () => {
    const requests: RunAgentInput[] = [];
    let served = 0;
    const fetch = async (_url: string, requestInit: RequestInit) => {
      const input = JSON.parse(requestInit.body as string) as RunAgentInput;
      requests.push(input);
      const all = backgroundRun(input.threadId, input.runId);
      served += 1;
      if (served === 1) {
        // A terminal, then a clean close, then nothing: the run ended, so the
        // agent has no reason to reconnect and no reason to remember where the
        // ending sat.
        return sseResponse(all);
      }
      return sseResponse([]);
    };
    const agent = makeAgent(fetch, true);

    const events = await runToArray(agent, inputFor("r1"));

    expect(requests).toHaveLength(1);
    expect(events[events.length - 1]!.type).toBe(EventType.RUN_FINISHED);
  });

  it("drops nothing on a first attempt, whatever the server stamps", async () => {
    const fetch = async (_url: string, requestInit: RequestInit) => {
      const input = JSON.parse(requestInit.body as string) as RunAgentInput;
      const all = backgroundRun(input.threadId, input.runId);
      // Two events sharing one position, which a first attempt has no grounds
      // to call a repeat of anything.
      return sseResponse(
        all.map(({ event, cursor }) => ({
          event: {
            ...event,
            metadata: { [AGNO_BACKGROUND_KEY]: { eventIndex: 0, subIndex: 0 } },
          },
          cursor,
        })),
      );
    };
    const agent = makeAgent(fetch, true);

    const result = await agent.runAgent();

    const assistant = result.newMessages.find(
      (message) => message.role === "assistant",
    );
    expect(assistant?.content).toBe(DELTAS.join(""));
  });

  it("recovers when a later leg places what an earlier one could not", async () => {
    let served = 0;
    const fetch = async (_url: string, requestInit: RequestInit) => {
      const input = JSON.parse(requestInit.body as string) as RunAgentInput;
      const all = backgroundRun(input.threadId, input.runId);
      served += 1;
      if (served === 1) {
        return sseResponse(all.slice(0, 3));
      }
      if (served === 2) {
        // One unplaceable event, then a close: this leg loses something, but
        // the run is not over and the next leg may still deliver it.
        const unmarked = {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: "m1",
          delta: "again ",
        };
        return sseResponse([
          { event: unmarked, cursor: { eventIndex: 0, subIndex: 0 } },
        ]);
      }
      return sseResponse(after(all, requestedCursor(input)));
    };
    const agent = makeAgent(fetch, true);

    const result = await agent.runAgent();

    const assistant = result.newMessages.find(
      (message) => message.role === "assistant",
    );
    expect(assistant?.content).toBe(DELTAS.join(""));
  });

  it("backs off further after each attempt that gets nowhere", async () => {
    const at: number[] = [];
    const started = Date.now();
    const fetch = async (_url: string, requestInit: RequestInit) => {
      const input = JSON.parse(requestInit.body as string) as RunAgentInput;
      at.push(Date.now() - started);
      const all = backgroundRun(input.threadId, input.runId);
      return sseResponse(at.length === 1 ? all.slice(0, 3) : []);
    };
    const agent = makeAgent(fetch, true, {
      maxReconnectAttempts: 3,
      reconnectDelayMs: 40,
    });

    await expect(runToArray(agent, inputFor("r1"))).rejects.toThrow(
      /made no progress/,
    );

    expect(at).toHaveLength(5);
    // Each wait doubles the one before it: roughly 40ms, 80ms, 160ms and
    // 320ms. Compared end to end rather than step by step, so ordinary timer
    // jitter cannot decide the result.
    const waits = at.slice(1).map((moment, index) => moment - at[index]!);
    expect(waits).toHaveLength(4);
    expect(waits[3]!).toBeGreaterThan(waits[0]! * 4);
  });

  it("treats a stamped error carrying the abort code as the run's own ending", async () => {
    const requests: RunAgentInput[] = [];
    const fetch = async (_url: string, requestInit: RequestInit) => {
      const input = JSON.parse(requestInit.body as string) as RunAgentInput;
      requests.push(input);
      const all = backgroundRun(input.threadId, input.runId);
      // The server's own cancellation: it carries the abort code but is placed
      // like every other event this server sends, so it is not a lost socket.
      const cancelled = {
        type: EventType.RUN_ERROR,
        message: "the run was cancelled",
        code: "abort",
        metadata: {
          [AGNO_BACKGROUND_KEY]: { eventIndex: 9, subIndex: 0 },
        },
      };
      return sseResponse([
        ...all.slice(0, 3),
        { event: cancelled, cursor: { eventIndex: 9, subIndex: 0 } },
      ]);
    };
    const agent = makeAgent(fetch, true);

    const events = await runToArray(agent, inputFor("r1"));

    expect(requests).toHaveLength(1);
    expect(events[events.length - 1]).toMatchObject({
      type: EventType.RUN_ERROR,
      message: "the run was cancelled",
    });
  });

  it("ignores a resume position the caller left in its forwarded props", async () => {
    const server = createResumingServer(99, 0);
    const agent = makeAgent(server.fetch, true);
    const input = inputFor("r1");
    input.forwardedProps = {
      [AGNO_BACKGROUND_KEY]: {
        enabled: false,
        lastEventIndex: 99,
        lastSubIndex: 4,
        note: "kept",
      },
    };

    await runToArray(agent, input);

    expect(backgroundPropsOf(server.requests[0]!)).toEqual({
      note: "kept",
      enabled: true,
    });
  });

  it("carries its background settings through a clone", () => {
    const agent = new AgnoAgent({
      url: "http://agno.invalid/agui",
      background: true,
      maxReconnectAttempts: 9,
      reconnectDelayMs: 33,
      fetch: vi.fn(),
    });

    const cloned = agent.clone();

    expect(cloned).toBeInstanceOf(AgnoAgent);
    expect(cloned.background).toBe(true);
    expect(cloned.maxReconnectAttempts).toBe(9);
    expect(cloned.reconnectDelayMs).toBe(33);
  });
});

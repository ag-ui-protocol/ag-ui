import { describe, expect, it, vi } from "vitest";
import { firstValueFrom, from } from "rxjs";
import { EventType as E, type BaseEvent, type RunAgentInput } from "@ag-ui/core";
import { CopilotAgent } from "../src/index.js";
import { FakeClient, FRONTEND_TOOL_TURN, TEXT_TURN, TOOLS, makeInput, run, type FakeSession, type Payload } from "./helpers.js";

describe("session lifecycle", () => {
  it("L1+L2: resumes the native session after a failed run, despite resolved tool messages", async () => {
    const script = [...FRONTEND_TOOL_TURN];
    const client = new FakeClient(script);
    const agent = new CopilotAgent({ client, runTimeoutMs: 200 });
    const transcript = makeInput({
      tools: TOOLS,
      messages: [
        ...makeInput().messages,
        { id: "result", role: "tool", toolCallId: "call-1", content: "ok" },
      ],
    });
    try {
      expect((await run(agent, makeInput({ tools: TOOLS }))).at(-1)!.type).toBe("RUN_FINISHED");
      expect((await run(agent, { ...transcript, runId: "resolved" })).at(-1)!.type).toBe("RUN_FINISHED");
      const session = client.session!;
      expect(session.resolved).toEqual(["req-1"]);

      script.splice(0, script.length, { id: "cancelled", type: "abort", data: {} });
      expect((await run(agent, {
        ...transcript, runId: "cancelled",
        messages: [...transcript.messages, { id: "u2", role: "user", content: "Cancel this turn" }],
      })).at(-1)).toMatchObject({ type: "RUN_ERROR", message: "Run cancelled" });
      expect(session.aborted).toBe(true);

      script.splice(0, script.length, ...TEXT_TURN);
      const next = await run(agent, {
        ...transcript, runId: "fresh",
        messages: [...transcript.messages, { id: "u3", role: "user", content: "A new question" }],
      });
      expect(next.filter((event) => event.type === "RUN_ERROR")).toEqual([]);
      expect(next.at(-1)).toMatchObject({ type: "RUN_FINISHED" });
      expect(client.session).not.toBe(session);
      expect(client.session!.prompts).toEqual(["A new question"]);
      // L2: the replacement is the same native session (and history), not a new one.
      expect(client.stored.size).toBe(1);
      expect(client.resumed).toEqual([...client.stored]);
    } finally {
      await agent.close();
    }
  });

  it("L3: ignores a replayed resume without discarding another pending call", async () => {
    const client = new FakeClient([
      ...FRONTEND_TOOL_TURN,
      {
        ...FRONTEND_TOOL_TURN[0]!, id: "second-call",
        data: { ...FRONTEND_TOOL_TURN[0]!.data, toolCallId: "call-2", requestId: "req-2" },
      },
    ]);
    const createSession = vi.spyOn(client, "createSession");
    const agent = new CopilotAgent({
      client, tools: TOOLS, interrupts: { change_background: (answer) => answer }, runTimeoutMs: 500,
    });
    const resolved = makeInput({
      runId: "resolve-first",
      resume: [{ interruptId: "call-1", status: "resolved", payload: "ok" }],
    });
    try {
      await run(agent, makeInput());
      const session = client.session!;
      expect((await run(agent, resolved)).at(-1)).toMatchObject({
        type: "RUN_FINISHED", outcome: { type: "interrupt", interrupts: [{ id: "call-2" }] },
      });
      const replay = await run(agent, {
        ...resolved, runId: "replay",
        messages: [
          ...resolved.messages,
          { id: "replayed-result", role: "tool", toolCallId: "call-1", content: "ok" },
        ],
      });
      expect(replay.filter((event) => event.type === "RUN_ERROR")).toEqual([]);
      expect(replay.at(-1)).toMatchObject({
        type: "RUN_FINISHED", outcome: { type: "interrupt", interrupts: [{ id: "call-2" }] },
      });
      expect(session.aborted).toBe(false);
      expect(session.disconnected).toBe(false);
      expect((await run(agent, makeInput({
        runId: "resolve-second",
        resume: [{ interruptId: "call-2", status: "resolved", payload: "ok" }],
      }))).at(-1)!.type).toBe("RUN_FINISHED");
      expect(createSession).toHaveBeenCalledTimes(1);
      expect(session.resolved).toEqual(["req-1", "req-2"]);
    } finally {
      await agent.close();
    }
  });

  it("L4a: evicts the least-recently-used thread, not the oldest insertion", async () => {
    const client = new FakeClient([{ id: "idle", type: "session.idle", data: {} }]);
    const agent = new CopilotAgent({ client, runTimeoutMs: 1_000 });
    const sessions: FakeSession[] = [];
    try {
      for (let index = 0; index < 32; index++) {
        await run(agent, makeInput({ threadId: `thread-${index}` }));
        sessions.push(client.session!);
      }
      await run(agent.clone(), makeInput({ threadId: "thread-0", runId: "recently-used" }));
      await run(agent, makeInput({ threadId: "thread-32" }));
      expect(sessions[0]!.aborted).toBe(false);
      expect(sessions[1]!.aborted).toBe(true);
      expect(sessions[1]!.disconnected).toBe(true);
    } finally {
      await agent.close();
    }
  });

  it("L4b: never evicts a busy thread to make room for a new thread", async () => {
    vi.useFakeTimers();
    const script: Payload[] = [];
    const client = new FakeClient(script);
    const agent = new CopilotAgent({ client, runTimeoutMs: 1_000 });
    const busy = run(agent, makeInput({ threadId: "busy" }));
    let busySession: FakeSession | undefined;
    try {
      await vi.advanceTimersByTimeAsync(0);
      busySession = client.session!;
      expect(busySession.prompts).toHaveLength(1);
      script.push({ id: "idle", type: "session.idle", data: {} });
      let oldestIdle: FakeSession | undefined;
      for (let index = 1; index < 32; index++) {
        await run(agent, makeInput({ threadId: `thread-${index}` }));
        oldestIdle ??= client.session!;
      }
      await run(agent.clone(), makeInput({ threadId: "thread-32" }));
      expect(busySession.aborted).toBe(false);
      expect(busySession.disconnected).toBe(false);
      expect(oldestIdle!.aborted).toBe(true);
      busySession.emit({ id: "busy-done", type: "session.idle", data: {} });
      expect((await busy).at(-1)!.type).toBe("RUN_FINISHED");
    } finally {
      busySession?.emit({ id: "cleanup", type: "session.idle", data: {} });
      await busy;
      await agent.close();
      vi.useRealTimers();
    }
  });

  it("L4c: refuses a new thread with RUN_STARTED + RUN_ERROR when every thread is busy", async () => {
    const client = new FakeClient([]); // no events: every run stays in flight
    const createSession = vi.spyOn(client, "createSession");
    const agent = new CopilotAgent({ client, runTimeoutMs: 60_000 });
    const busy = Array.from({ length: 32 }, (_, index) => run(agent, makeInput({ threadId: `busy-${index}` })));
    try {
      await vi.waitFor(() => expect(createSession).toHaveBeenCalledTimes(32));
      const refused = await run(agent, makeInput({ threadId: "extra" }));
      expect(refused.map((event) => event.type)).toEqual([E.RUN_STARTED, E.RUN_ERROR]);
      expect(refused.at(-1)).toMatchObject({ message: expect.stringMatching(/capacity/i) });
      const sessions = (await Promise.all(createSession.mock.results.map((result) => result.value))) as FakeSession[];
      expect(sessions.some((session) => session.aborted)).toBe(false);
      expect(createSession).toHaveBeenCalledTimes(32);
      for (const session of sessions) session.emit({ id: "done", type: "session.idle", data: {} });
      for (const events of await Promise.all(busy)) expect(events.at(-1)!.type).toBe(E.RUN_FINISHED);
    } finally {
      await agent.close();
    }
  });

  it("L5: releases busy when a consumer closes the stream at its first yield", async () => {
    vi.useFakeTimers();
    const client = new FakeClient(TEXT_TURN);
    const agent = new CopilotAgent({ client, runTimeoutMs: 200 });
    try {
      // The public Observable signals cancellation but keeps draining the generator.
      expect((await firstValueFrom(agent.run(makeInput()))).type).toBe("RUN_STARTED");
      await vi.advanceTimersByTimeAsync(0);
      expect(client.session!.aborted).toBe(true);
      expect((await run(agent, makeInput({ runId: "public-retry" }))).at(-1)!.type).toBe("RUN_FINISHED");

      // An iterator consumer also calls return() on unsubscribe, exposing the gap.
      const stream = (agent as unknown as {
        stream(input: RunAgentInput, signal: AbortSignal): AsyncGenerator<BaseEvent>;
      }).stream(makeInput({ threadId: "iterator" }), new AbortController().signal);
      expect((await firstValueFrom(from(stream))).type).toBe("RUN_STARTED");
      await vi.advanceTimersByTimeAsync(0);
      await expect(run(agent, makeInput({
        threadId: "iterator", runId: "iterator-retry",
      }))).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ type: "RUN_FINISHED" })]));
    } finally {
      await agent.close();
      vi.useRealTimers();
    }
  });
});

describe("tools changing between turns", () => {
  it("re-opens the native session with the new tool list", async () => {
    const client = new FakeClient(TEXT_TURN);
    const agent = new CopilotAgent({ client, runTimeoutMs: 1000 });
    expect((await run(agent, makeInput())).at(-1)?.type).toBe(E.RUN_FINISHED);
    expect(client.config?.tools?.map((t) => t.name)).toEqual([]);
    const second = [
      { id: "u1", role: "user" as const, content: "Say hello." },
      { id: "u2", role: "user" as const, content: "Now change the background." },
    ];
    const events = await run(agent, makeInput({ runId: "r2", tools: TOOLS, messages: second }));
    expect(events.at(-1)?.type).toBe(E.RUN_FINISHED);
    expect(client.config?.tools?.map((t) => t.name)).toEqual(["change_background"]);
    expect(client.session?.prompts).toEqual(["Now change the background."]);
    // Same tools again: the live session is kept.
    const live = client.session;
    await run(agent, makeInput({ runId: "r3", tools: TOOLS, messages: [...second, { id: "u3", role: "user", content: "Again." }] }));
    expect(client.session).toBe(live);
  });

  it("bounds a stalled disconnect when re-opening by the run deadline", async () => {
    const client = new FakeClient(TEXT_TURN);
    const agent = new CopilotAgent({ client, runTimeoutMs: 50 });
    await run(agent, makeInput());
    client.session!.disconnect = () => new Promise((resolve) => setTimeout(resolve, 200));
    const second = [{ id: "u2", role: "user" as const, content: "Now change the background." }];
    const events = await run(agent, makeInput({ runId: "r2", tools: TOOLS, messages: second }));
    expect(events.at(-1)?.type).toBe(E.RUN_ERROR);
  });
});

describe("teardown after a failed run", () => {
  it("keeps the thread reserved until the old session is disconnected", async () => {
    const client = new FakeClient(TEXT_TURN, true);
    let closing!: () => void;
    const closingStarted = new Promise<void>((resolve) => (closing = resolve));
    const create = client.createSession.bind(client);
    client.createSession = async (config) => {
      const session = await create(config);
      session.abort = () => (closing(), new Promise((resolve) => setTimeout(resolve, 50)));
      return session;
    };
    const agent = new CopilotAgent({ client, runTimeoutMs: 20 });
    const first = run(agent, makeInput());
    await closingStarted;
    // A retry during teardown must not resume the session that is being closed.
    const retry = await run(agent, makeInput({ runId: "r2" }));
    expect(retry.at(-1)).toMatchObject({ type: E.RUN_ERROR, message: "Thread already has an active run" });
    expect(client.resumed).toEqual([]);
    expect((await first).at(-1)?.type).toBe(E.RUN_ERROR);
    await agent.close();
  });

  it("makes an overlapping close() wait for the teardown in progress", async () => {
    const client = new FakeClient(TEXT_TURN, true);
    let closing!: () => void;
    const closingStarted = new Promise<void>((resolve) => (closing = resolve));
    let detached = false;
    const create = client.createSession.bind(client);
    client.createSession = async (config) => {
      const session = await create(config);
      // Like the SDK, a second disconnect returns at once while the first is still detaching.
      let calls = 0;
      session.disconnect = async () => {
        if (calls++) return;
        closing();
        await new Promise((resolve) => setTimeout(resolve, 50));
        detached = true;
      };
      return session;
    };
    const agent = new CopilotAgent({ client, runTimeoutMs: 20 });
    const first = run(agent, makeInput());
    await closingStarted;
    await agent.close();
    expect(detached).toBe(true);
    await first;
  });
});

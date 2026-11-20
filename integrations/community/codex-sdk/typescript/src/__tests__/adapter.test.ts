import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lastValueFrom, toArray } from "rxjs";
import {
  EventType,
  type BaseEvent,
  type Message,
  type RunAgentInput,
} from "@ag-ui/core";
import type { ThreadEvent } from "@openai/codex-sdk";
import { CodexAgentAdapter } from "../adapter";
import { MemoryCodexSessionStore } from "../sessions";
import { EventSchemas } from "@ag-ui/core/schemas";

const sdk = vi.hoisted(() => ({
  create: vi.fn(),
  start: vi.fn(),
  resume: vi.fn(),
  run: vi.fn(),
}));
vi.mock("../sdk", () => ({ createCodex: sdk.create }));
const usage = {
  input_tokens: 1,
  cached_input_tokens: 0,
  cache_write_input_tokens: 0,
  output_tokens: 2,
  reasoning_output_tokens: 0,
};
const user = { id: "u1", role: "user", content: "Hello" } satisfies Message;
function input(overrides: Partial<RunAgentInput> = {}): RunAgentInput {
  return {
    threadId: "thread",
    runId: "run",
    messages: [user],
    tools: [],
    context: [],
    state: {},
    forwardedProps: {},
    ...overrides,
  };
}
async function* success(): AsyncGenerator<ThreadEvent> {
  yield { type: "thread.started", thread_id: "native-thread" };
  yield { type: "turn.started" };
  yield {
    type: "item.completed",
    item: { type: "agent_message", id: "item", text: "Answer" },
  };
  yield { type: "turn.completed", usage };
}
async function collect(
  agent: CodexAgentAdapter,
  request = input(),
): Promise<BaseEvent[]> {
  const events = await lastValueFrom(agent.run(request).pipe(toArray()));
  for (const event of events) EventSchemas.parse(event);
  return events;
}
function terminal(events: BaseEvent[]) {
  return events.filter(
    (event) =>
      event.type === EventType.RUN_FINISHED ||
      event.type === EventType.RUN_ERROR,
  );
}
function waiting(signal?: AbortSignal): AsyncGenerator<ThreadEvent> {
  return (async function* () {
    yield {
      type: "thread.started",
      thread_id: "native-waiting",
    } satisfies ThreadEvent;
    await new Promise<void>((_, reject) => {
      if (signal?.aborted) reject(signal.reason);
      else
        signal?.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
    });
  })();
}

beforeEach(() => {
  vi.clearAllMocks();
  sdk.create.mockResolvedValue({
    startThread: sdk.start,
    resumeThread: sdk.resume,
  });
  sdk.start.mockReturnValue({ id: null, runStreamed: sdk.run });
  sdk.resume.mockReturnValue({ id: "native-thread", runStreamed: sdk.run });
  sdk.run.mockImplementation(async () => ({ events: success() }));
});
afterEach(() => vi.useRealTimers());

describe("CodexAgentAdapter", () => {
  it("constructs without resolving SDK or credentials and clones with shared admission", () => {
    const agent = new CodexAgentAdapter({
      codexOptions: { apiKey: "host-only" },
      maxItems: 10,
    });
    const clone = agent.clone();
    expect(clone).toBeInstanceOf(CodexAgentAdapter);
    expect(sdk.create).not.toHaveBeenCalled();
    expect(clone.isRunning).toBe(false);
  });

  it("resumes only trusted native sessions and sends only appended text", async () => {
    const agent = new CodexAgentAdapter();
    const first = await collect(agent);
    expect(terminal(first)).toHaveLength(1);
    expect(terminal(first)[0]?.type).toBe(EventType.RUN_FINISHED);
    const start = first.find(
      (event) => event.type === EventType.TEXT_MESSAGE_START,
    );
    expect(start && "messageId" in start).toBe(true);
    if (
      !start ||
      !("messageId" in start) ||
      typeof start.messageId !== "string"
    )
      throw new Error("Missing assistant id");
    await collect(
      agent.clone(),
      input({
        runId: "run2",
        messages: [
          user,
          { id: start.messageId, role: "assistant", content: "Answer" },
          { id: "u2", role: "user", content: "Again" },
        ],
      }),
    );
    expect(sdk.resume).toHaveBeenCalledWith(
      "native-thread",
      expect.objectContaining({
        sandboxMode: "read-only",
        approvalPolicy: "never",
        networkAccessEnabled: false,
        webSearchMode: "disabled",
      }),
    );
    expect(sdk.run.mock.calls[1]?.[0]).toContain("Again");
    expect(sdk.run.mock.calls[1]?.[0]).not.toContain("Hello");
    expect(sdk.run.mock.calls[1]?.[0]).not.toContain("Answer");
  });

  it("reconstructs assistant messages through the public runAgent client", async () => {
    const agent = new CodexAgentAdapter({
      threadId: "thread",
      initialMessages: [user],
    });
    await agent.runAgent();
    expect(agent.messages).toContainEqual(
      expect.objectContaining({ role: "assistant", content: "Answer" }),
    );
    agent.addMessage({ id: "u2", role: "user", content: "Next" });
    await agent.runAgent();
    expect(sdk.resume).toHaveBeenCalledTimes(1);
  });

  it("rejects unsupported input before SDK initialization and permits later valid input", async () => {
    const agent = new CodexAgentAdapter();
    const events = await collect(
      agent,
      input({ forwardedProps: { nativeId: "untrusted" } }),
    );
    expect(terminal(events)[0]).toMatchObject({
      type: EventType.RUN_ERROR,
      code: "UNSUPPORTED_OVERRIDES",
    });
    expect(sdk.create).not.toHaveBeenCalled();
    expect(terminal(await collect(agent))[0]?.type).toBe(
      EventType.RUN_FINISHED,
    );
  });

  it("rejects concurrent clone writers without changing the active session", async () => {
    sdk.run.mockImplementation(
      async (_prompt: string, options: { signal: AbortSignal }) => ({
        events: waiting(options.signal),
      }),
    );
    const store = new MemoryCodexSessionStore();
    const agent = new CodexAgentAdapter({ sessionStore: store });
    const first = collect(agent);
    await vi.waitFor(() => expect(sdk.run).toHaveBeenCalledTimes(1));
    const collision = await collect(agent.clone());
    expect(terminal(collision)[0]).toMatchObject({
      type: EventType.RUN_ERROR,
      code: "THREAD_BUSY",
    });
    expect(store.get("thread")?.status).toBe("reserved");
    agent.abortRun();
    expect(terminal(await first)[0]).toMatchObject({
      type: EventType.RUN_ERROR,
      code: "CANCELLED",
    });
    expect(store.get("thread")?.status).toBe("failed");
    expect(() => store.acquire("thread")).not.toThrow();
    store.release("thread");
  });

  it("allows independent concurrent threads and aborts only the owning adapter", async () => {
    sdk.run.mockImplementation(
      async (_prompt: string, options: { signal: AbortSignal }) => ({
        events: waiting(options.signal),
      }),
    );
    const store = new MemoryCodexSessionStore();
    const first = new CodexAgentAdapter({ sessionStore: store });
    const second = first.clone();
    const a = collect(first);
    const b = collect(second, input({ threadId: "other" }));
    await vi.waitFor(() => expect(sdk.run).toHaveBeenCalledTimes(2));
    first.abortRun();
    expect(terminal(await a)[0]).toMatchObject({ code: "CANCELLED" });
    expect(store.get("other")?.status).toBe("reserved");
    second.abortRun();
    await b;
  });

  it("sanitizes SDK errors and rejects continuation of failed sessions", async () => {
    sdk.run.mockRejectedValueOnce(new Error("SECRET provider stderr"));
    const store = new MemoryCodexSessionStore();
    const diagnostics = vi.fn();
    const agent = new CodexAgentAdapter({
      sessionStore: store,
      onError: diagnostics,
    });
    const events = await collect(agent);
    expect(terminal(events)[0]).toMatchObject({ code: "CODEX_ERROR" });
    expect(JSON.stringify(events)).not.toContain("SECRET");
    expect(diagnostics).toHaveBeenCalledOnce();
    expect(store.get("thread")?.status).toBe("failed");
    expect(terminal(await collect(agent))[0]).toMatchObject({
      code: "SESSION_FAILED",
    });
    expect(sdk.run).toHaveBeenCalledOnce();
  });

  it("treats process failure after staged completion as one error terminal", async () => {
    sdk.run.mockImplementation(async () => ({
      events: (async function* () {
        yield* success();
        throw new Error("late process failure");
      })(),
    }));
    const events = await collect(new CodexAgentAdapter());
    expect(terminal(events)).toEqual([
      expect.objectContaining({ type: EventType.RUN_ERROR }),
    ]);
  });

  it("aborts deadlines and unsubscribes without keeping admission", async () => {
    sdk.run.mockImplementation(
      async (_prompt: string, options: { signal: AbortSignal }) => ({
        events: waiting(options.signal),
      }),
    );
    const store = new MemoryCodexSessionStore();
    const agent = new CodexAgentAdapter({
      sessionStore: store,
      runTimeoutMs: 20,
    });
    expect(terminal(await collect(agent))[0]).toMatchObject({
      code: "RUN_TIMEOUT",
    });
    const other = input({ threadId: "disconnect" });
    const subscription = agent.run(other).subscribe();
    await vi.waitFor(() => expect(sdk.run).toHaveBeenCalledTimes(2));
    subscription.unsubscribe();
    await vi.waitFor(() =>
      expect(store.get("disconnect")?.status).toBe("failed"),
    );
    await vi.waitFor(() =>
      expect(() => store.acquire("disconnect")).not.toThrow(),
    );
    store.release("disconnect");
  });

  it("enforces configured limits on direct calls", async () => {
    expect(
      terminal(await collect(new CodexAgentAdapter({ maxInputBytes: 10 })))[0],
    ).toMatchObject({ code: "INPUT_LIMIT" });
    expect(
      terminal(await collect(new CodexAgentAdapter({ maxMessages: 1 })))[0],
    ).toMatchObject({ code: "MESSAGE_LIMIT" });
    expect(sdk.run).not.toHaveBeenCalled();
    const textEvents = await collect(
      new CodexAgentAdapter({ maxTextBytes: 2 }),
    );
    expect(terminal(textEvents)[0]?.type).toBe(EventType.RUN_ERROR);
    expect(() => new CodexAgentAdapter({ maxItems: Infinity })).toThrow(
      "positive safe integer",
    );
  });
  it("signals translator failures before iterator return and retains admission through cleanup", async () => {
    const store = new MemoryCodexSessionStore();
    let releaseCleanup: (() => void) | undefined;
    let cleanupStarted = false;
    let abortedBeforeReturn = false;
    sdk.run.mockImplementation(
      async (_prompt: string, options: { signal: AbortSignal }) => ({
        events: (async function* () {
          try {
            yield {
              type: "thread.started",
              thread_id: "native-limit",
            } satisfies ThreadEvent;
            yield {
              type: "item.completed",
              item: { type: "agent_message", id: "item", text: "too long" },
            } satisfies ThreadEvent;
          } finally {
            abortedBeforeReturn = options.signal.aborted;
            cleanupStarted = true;
            await new Promise<void>((resolve) => {
              releaseCleanup = resolve;
            });
          }
        })(),
      }),
    );
    const pending = collect(
      new CodexAgentAdapter({ sessionStore: store, maxTextBytes: 2 }),
    );
    await vi.waitFor(() => expect(cleanupStarted).toBe(true));
    expect(abortedBeforeReturn).toBe(true);
    expect(() => store.acquire("thread")).toThrow("already active");
    if (!releaseCleanup) throw new Error("Missing cleanup release");
    releaseCleanup();
    expect(terminal(await pending)[0]).toMatchObject({
      type: EventType.RUN_ERROR,
      code: "TEXT_LIMIT",
    });
    expect(() => store.acquire("thread")).not.toThrow();
    store.release("thread");
  });

  it("does not abort an SDK iterator after its own error cleanup", async () => {
    let observedSignal: AbortSignal | undefined;
    sdk.run.mockImplementation(
      async (_prompt: string, options: { signal: AbortSignal }) => {
        observedSignal = options.signal;
        return {
          events: (async function* () {
            yield await Promise.reject(new Error("malformed native JSON"));
          })(),
        };
      },
    );
    expect(terminal(await collect(new CodexAgentAdapter()))[0]).toMatchObject({
      code: "CODEX_ERROR",
    });
    expect(observedSignal?.aborted).toBe(false);
  });

  it.each([true, false])(
    "continues with reasoning summaries when client retention is %s",
    async (retainReasoning) => {
      sdk.run.mockImplementation(async () => ({
        events: (async function* () {
          yield {
            type: "thread.started",
            thread_id: "native-thread",
          } satisfies ThreadEvent;
          yield {
            type: "item.completed",
            item: { type: "reasoning", id: "thought", text: "Public summary" },
          } satisfies ThreadEvent;
          yield {
            type: "item.completed",
            item: { type: "agent_message", id: "item", text: "Answer" },
          } satisfies ThreadEvent;
          yield { type: "turn.completed", usage } satisfies ThreadEvent;
        })(),
      }));
      const agent = new CodexAgentAdapter({
        threadId: "thread",
        initialMessages: [user],
        showReasoning: true,
      });
      await agent.runAgent();
      expect(
        agent.messages.some((message) => message.role === "reasoning"),
      ).toBe(true);
      if (!retainReasoning)
        agent.setMessages(
          agent.messages.filter((message) => message.role !== "reasoning"),
        );
      agent.addMessage({ id: "next", role: "user", content: "Next question" });
      await agent.runAgent();
      expect(sdk.resume).toHaveBeenCalledOnce();
      expect(sdk.run.mock.calls[1]?.[0]).toContain("Next question");
      expect(sdk.run.mock.calls[1]?.[0]).not.toContain("Public summary");
    },
  );

  it("rejects evicted assistant history rather than replaying it into a fresh native session", async () => {
    const store = new MemoryCodexSessionStore({ maxEntries: 1 });
    const agent = new CodexAgentAdapter({
      sessionStore: store,
      threadId: "thread",
      initialMessages: [user],
    });
    await agent.runAgent();
    await collect(agent.clone(), input({ threadId: "replacement" }));
    agent.addMessage({ id: "next", role: "user", content: "Continue" });
    expect(
      terminal(await collect(agent, input({ messages: agent.messages })))[0],
    ).toMatchObject({ code: "SESSION_EXPIRED" });
    expect(sdk.start).toHaveBeenCalledTimes(2);
  });
  it("waits for owned SDK disposal before success and admission release", async () => {
    const store = new MemoryCodexSessionStore();
    let releaseDisposal: (() => void) | undefined;
    const dispose = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseDisposal = resolve;
        }),
    );
    sdk.create.mockResolvedValue({
      startThread: sdk.start,
      resumeThread: sdk.resume,
      dispose,
    });
    const pending = collect(new CodexAgentAdapter({ sessionStore: store }));
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
    expect(() => store.acquire("thread")).toThrow("already active");
    if (!releaseDisposal) throw new Error("Missing disposal release");
    releaseDisposal();
    expect(terminal(await pending)[0]?.type).toBe(EventType.RUN_FINISHED);
    expect(() => store.acquire("thread")).not.toThrow();
    store.release("thread");
  });

  it("quarantines admission and emits one safe error if owned cleanup cannot be confirmed", async () => {
    const store = new MemoryCodexSessionStore();
    const diagnostics = vi.fn();
    sdk.create.mockResolvedValue({
      startThread: sdk.start,
      resumeThread: sdk.resume,
      dispose: vi
        .fn()
        .mockRejectedValue(new Error("private cleanup diagnostics")),
    });
    const events = await collect(
      new CodexAgentAdapter({ sessionStore: store, onError: diagnostics }),
    );
    expect(terminal(events)).toEqual([
      expect.objectContaining({
        type: EventType.RUN_ERROR,
        code: "CLEANUP_FAILED",
      }),
    ]);
    expect(JSON.stringify(events)).not.toContain("private cleanup diagnostics");
    expect(store.get("thread")?.status).toBe("failed");
    expect(() => store.acquire("thread")).toThrow("already active");
    expect(diagnostics).toHaveBeenCalledOnce();
  });
});

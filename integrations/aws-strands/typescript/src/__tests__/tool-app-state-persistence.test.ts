/**
 * Application state a tool keeps in the Strands agent's `appState`.
 *
 * AG-UI shared state and durable application state are different things. A
 * `stateFromArgs` / `stateFromResult` hook turns a tool call into a
 * STATE_SNAPSHOT for the UI, which is transport only. State that has to survive
 * a restart belongs to the tool: it writes `context.agent.appState`, and the
 * configured SessionManager persists and restores that with the thread. The
 * adapter's part is to leave those keys alone and to run the SessionManager
 * lifecycle, which these tests pin through the real run path.
 *
 * Everything here is real except the model: a real `Agent`, a real
 * `SessionManager` over an on-disk `FileStorage`, and a restart that shares
 * nothing with the first process but the storage directory.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { FileStorage, SessionManager, tool } from "@strands-agents/sdk";
import { z } from "zod";
import { EventType, type BaseEvent } from "@ag-ui/core";

import type { StrandsAgentConfig } from "../config";
import { AG_UI_FRONTEND_CALL_IDS_STATE_KEY } from "../session-reconcile";
import {
  collect,
  expectCompletedRun,
  minimalRunInput,
  modelTurn,
  persistedSnapshot,
  realStrandsAgent,
  threadAgent,
  type PersistedSnapshot,
} from "./helpers";

const KEY = "todos";

const dirs: string[] = [];

function storageDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agui-strands-app-state-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** Replaces the list, keeping it where the SDK tells tools durable state goes. */
const writeTodos = tool({
  name: "write_todos",
  description: "Replace the todo list.",
  inputSchema: z.object({ todos: z.array(z.string()) }),
  callback: ({ todos }, context) => {
    if (!context) throw new Error("the SDK ran the tool without a context");
    context.agent.appState.set(KEY, todos);
    return { stored: todos.length };
  },
});

/** Hands back whatever the thread's app state holds, as the model would see it. */
const readTodos = tool({
  name: "read_todos",
  description: "Read the todo list.",
  inputSchema: z.object({}),
  callback: (_input, context) => {
    if (!context) throw new Error("the SDK ran the tool without a context");
    return { todos: context.agent.appState.get(KEY) ?? null };
  },
});

/** A fresh adapter, agent and session manager over `dir`, as a restart gives. */
function bootProcess(
  dir: string,
  turns: Parameters<typeof realStrandsAgent>[0],
  config: Omit<StrandsAgentConfig, "sessionManagerProvider"> = {},
) {
  return realStrandsAgent(turns, {
    tools: [writeTodos, readTodos],
    config: {
      ...config,
      sessionManagerProvider: (input) =>
        new SessionManager({
          sessionId: input.threadId,
          storage: { snapshot: new FileStorage(dir) },
        }),
    },
  });
}

/** The thread's persisted snapshot. Each thread is its own session. */
function threadSnapshot(dir: string, threadId: string): PersistedSnapshot {
  return persistedSnapshot(join(dir, threadId));
}

const write = (toolUseId: string, todos: string[]) =>
  modelTurn.toolUse({ toolUseId, name: "write_todos", input: { todos } });

const read = (toolUseId: string) =>
  modelTurn.toolUse({ toolUseId, name: "read_todos", input: {} });

/** The TOOL_CALL_RESULT content the client saw for `toolCallId`, parsed. */
function toolResultContent(events: BaseEvent[], toolCallId: string): unknown {
  const result = events.find(
    (e) =>
      e.type === EventType.TOOL_CALL_RESULT &&
      (e as { toolCallId?: string }).toolCallId === toolCallId,
  ) as { content?: string } | undefined;
  expect(result, `no TOOL_CALL_RESULT for ${toolCallId}`).toBeDefined();
  return JSON.parse(result!.content!);
}

/** Every STATE_SNAPSHOT payload the run emitted, in order. */
function stateSnapshots(events: BaseEvent[]): Record<string, unknown>[] {
  return events
    .filter((e) => e.type === EventType.STATE_SNAPSHOT)
    .map(
      (e) => (e as unknown as { snapshot: Record<string, unknown> }).snapshot,
    );
}

describe("state a tool keeps in appState", () => {
  it("is persisted and restored by a fresh process, history unchanged", async () => {
    const dir = storageDir();
    const first = bootProcess(dir, [
      write("w1", ["a", "b"]),
      modelTurn.text("ok"),
    ]);
    expectCompletedRun(await collect(first.agent, minimalRunInput()));

    const persisted = threadSnapshot(dir, "thread-1");
    expect(persisted.data.state[KEY]).toEqual(["a", "b"]);
    const historyBefore = persisted.data.messages;
    expect(historyBefore).toEqual(
      threadAgent(first.agent)!.messages.map((m) => m.toJSON()),
    );

    const restarted = bootProcess(dir, [read("r1"), modelTurn.text("done")]);
    const events = await collect(
      restarted.agent,
      minimalRunInput({ runId: "run-2" }),
    );
    expectCompletedRun(events, "restarted run");

    expect(toolResultContent(events, "r1")).toEqual({ todos: ["a", "b"] });
    // The restored thread starts from exactly the history the first process
    // persisted, both the call that wrote the state and its result.
    const restoredHistory = threadAgent(restarted.agent)!.messages.map((m) =>
      m.toJSON(),
    );
    expect(restoredHistory.slice(0, historyBefore.length)).toEqual(
      historyBefore,
    );
    expect(
      restarted.model.seenMessages[0]
        .slice(0, historyBefore.length)
        .map((m) => m.toJSON()),
    ).toEqual(historyBefore);
  });

  it("keeps only the latest value across repeated updates", async () => {
    const dir = storageDir();
    const first = bootProcess(dir, [
      write("w1", ["a"]),
      write("w2", ["a", "b"]),
      modelTurn.text("ok"),
    ]);
    expectCompletedRun(await collect(first.agent, minimalRunInput()));
    expect(threadSnapshot(dir, "thread-1").data.state[KEY]).toEqual(["a", "b"]);

    const second = bootProcess(dir, [write("w3", ["c"]), modelTurn.text("ok")]);
    expectCompletedRun(
      await collect(second.agent, minimalRunInput({ runId: "run-2" })),
    );
    expect(threadSnapshot(dir, "thread-1").data.state).toEqual({
      [KEY]: ["c"],
    });

    const third = bootProcess(dir, [read("r1"), modelTurn.text("done")]);
    const events = await collect(
      third.agent,
      minimalRunInput({ runId: "run-3" }),
    );
    expectCompletedRun(events, "third run");
    expect(toolResultContent(events, "r1")).toEqual({ todos: ["c"] });
  });

  it("stays with its own thread", async () => {
    const dir = storageDir();
    // One scripted model backs every thread, so its turns are in run order.
    const first = bootProcess(dir, [
      write("wa", ["for A"]),
      modelTurn.text("ok"),
      write("wb", ["for B"]),
      modelTurn.text("ok"),
    ]);
    expectCompletedRun(
      await collect(first.agent, minimalRunInput({ threadId: "thread-a" })),
    );
    expectCompletedRun(
      await collect(first.agent, minimalRunInput({ threadId: "thread-b" })),
    );
    expect(threadSnapshot(dir, "thread-a").data.state).toEqual({
      [KEY]: ["for A"],
    });
    expect(threadSnapshot(dir, "thread-b").data.state).toEqual({
      [KEY]: ["for B"],
    });

    const restarted = bootProcess(dir, [
      read("ra"),
      modelTurn.text("ok"),
      read("rb"),
      modelTurn.text("ok"),
      read("rc"),
      modelTurn.text("ok"),
    ]);
    const a = await collect(
      restarted.agent,
      minimalRunInput({ threadId: "thread-a", runId: "run-2" }),
    );
    const b = await collect(
      restarted.agent,
      minimalRunInput({ threadId: "thread-b", runId: "run-2" }),
    );
    const c = await collect(
      restarted.agent,
      minimalRunInput({ threadId: "thread-c", runId: "run-1" }),
    );
    expect(toolResultContent(a, "ra")).toEqual({ todos: ["for A"] });
    expect(toolResultContent(b, "rb")).toEqual({ todos: ["for B"] });
    expect(toolResultContent(c, "rc")).toEqual({ todos: null });
  });

  it("survives the adapter's own app-state bookkeeping on the same thread", async () => {
    const dir = storageDir();
    const first = bootProcess(dir, [write("w1", ["a"]), modelTurn.text("ok")]);
    expectCompletedRun(await collect(first.agent, minimalRunInput()));

    // A frontend call makes the adapter record the call id in appState and
    // checkpoint the halted turn itself.
    const frontend = bootProcess(dir, [
      modelTurn.toolUse({
        toolUseId: "fe-1",
        name: "set_color",
        input: { color: "red" },
      }),
    ]);
    const events = await collect(
      frontend.agent,
      minimalRunInput({
        runId: "run-2",
        tools: [
          {
            name: "set_color",
            description: "Sets a UI color.",
            parameters: {
              type: "object",
              properties: { color: { type: "string" } },
            },
          },
        ] as never,
      }),
    );
    expect(events.map((e) => e.type)).toContain(EventType.RUN_FINISHED);

    const state = threadSnapshot(dir, "thread-1").data.state;
    expect(state[AG_UI_FRONTEND_CALL_IDS_STATE_KEY]).toEqual(["fe-1"]);
    expect(state[KEY]).toEqual(["a"]);
  });

  it("survives interrupt bookkeeping on the same thread", async () => {
    const dir = storageDir();
    const first = bootProcess(dir, [write("w1", ["a"]), modelTurn.text("ok")]);
    expectCompletedRun(await collect(first.agent, minimalRunInput()));

    const gated = bootProcess(dir, [read("r1")], {
      toolBehaviors: { read_todos: { interruptOnCall: true } },
    });
    const events = await collect(
      gated.agent,
      minimalRunInput({ runId: "run-2" }),
    );
    const finished = events.find((e) => e.type === EventType.RUN_FINISHED) as
      | { outcome?: { type?: string } }
      | undefined;
    expect(finished?.outcome?.type).toBe("interrupt");

    const state = threadSnapshot(dir, "thread-1").data.state;
    expect(state).toHaveProperty("ag_ui_interrupt_bookkeeping");
    expect(state[KEY]).toEqual(["a"]);
  });
});

describe("a STATE_SNAPSHOT from a tool behaviour", () => {
  it("reaches the client without being written to appState", async () => {
    const dir = storageDir();
    const { agent } = bootProcess(
      dir,
      [
        modelTurn.toolUse({
          toolUseId: "s1",
          name: "read_todos",
          input: {},
        }),
        modelTurn.text("ok"),
      ],
      {
        toolBehaviors: {
          read_todos: { stateFromArgs: () => ({ [KEY]: ["from args"] }) },
        },
      },
    );
    const events = await collect(
      agent,
      minimalRunInput({ state: { [KEY]: ["from the client"], other: 1 } }),
    );
    expectCompletedRun(events);

    expect(stateSnapshots(events)).toContainEqual({ [KEY]: ["from args"] });
    expect(stateSnapshots(events).at(-1)).toEqual({
      [KEY]: ["from args"],
      other: 1,
    });
    // Neither the snapshot the hook produced nor the state the client sent
    // is native state: the thread's appState and the persisted copy hold none.
    expect(threadAgent(agent)!.appState.getAll()).toEqual({});
    expect(threadSnapshot(dir, "thread-1").data.state).toEqual({});
    expect(toolResultContent(events, "s1")).toEqual({ todos: null });
  });
});

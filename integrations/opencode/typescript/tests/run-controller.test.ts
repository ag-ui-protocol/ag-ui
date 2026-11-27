import { it, expect, vi } from "vitest";
import type { BaseEvent } from "@ag-ui/core";
import type { OpenCodeTransport } from "../src/transport";
import type { SessionRecord, SessionStore } from "../src/session-store";
import { OpenCodeBridge } from "../src/run-controller";

const info = (id: string, parentID = "prompt", finish?: string) => ({
  id,
  sessionID: "session",
  role: "assistant",
  parentID,
  time: { created: 1, ...(finish ? { completed: 2 } : {}) },
  finish,
});
function setup(
  eventFactory: (prompt: string) => any[],
  overrides: Partial<OpenCodeTransport> = {},
) {
  let prompt = "";
  let record: SessionRecord | undefined;
  const transport: OpenCodeTransport = {
    create: vi.fn(async () => "session"),
    subscribe: vi.fn(async () => ({
      async *[Symbol.asyncIterator]() {
        yield* eventFactory(prompt);
      },
    })),
    prompt: vi.fn(async (_s, id) => {
      prompt = id;
    }),
    messages: vi.fn(async () => []),
    abort: vi.fn(async () => {}),
    permissions: vi.fn(async () => []),
    questions: vi.fn(async () => []),
    replyPermission: vi.fn(async () => {}),
    replyQuestion: vi.fn(async () => {}),
    ...overrides,
  };
  const store: SessionStore = {
    acquire: async () => async () => {},
    read: async () => record && structuredClone(record),
    write: async (_key, value) => {
      record = structuredClone(value);
    },
  };
  const events: BaseEvent[] = [];
  const controller = new AbortController();
  const bridge = new OpenCodeBridge({
    transport,
    store,
    directory: "/project",
  });
  const run = () =>
    bridge.run(
      {
        threadId: "thread",
        runId: "run",
        tools: [],
        context: [],
        messages: [{ id: "u", role: "user", content: "Hi" }],
      },
      { owner: "user", directory: "/project", signal: controller.signal },
      (e) => events.push(e),
    );
  return { transport, events, run, controller, record: () => record };
}
it("never completes from idle, another parent, or a tool-call finish", async () => {
  const test = setup((prompt) => [
    { id: "1", type: "session.idle", properties: { sessionID: "session" } },
    {
      id: "2",
      type: "message.updated",
      properties: {
        sessionID: "session",
        info: info("other", "other-prompt", "stop"),
      },
    },
    {
      id: "3",
      type: "message.updated",
      properties: {
        sessionID: "session",
        info: info("own", prompt, "tool-calls"),
      },
    },
  ]);
  await test.run();
  expect(test.events.at(-1)?.type).toBe("RUN_ERROR");
  expect(test.transport.abort).toHaveBeenCalledOnce();
});
it("deduplicates event IDs and handles parts preceding assistant identity", async () => {
  const test = setup((prompt) => [
    {
      id: "1",
      type: "message.part.updated",
      properties: {
        sessionID: "session",
        part: {
          id: "p",
          sessionID: "session",
          messageID: "a",
          type: "text",
          text: "Hi",
        },
      },
    },
    {
      id: "2",
      type: "message.updated",
      properties: { sessionID: "session", info: info("a", prompt) },
    },
    ...[1, 2].map(() => ({
      id: "3",
      type: "message.part.delta",
      properties: {
        sessionID: "session",
        messageID: "a",
        partID: "p",
        field: "text",
        delta: "!",
      },
    })),
    {
      id: "4",
      type: "message.updated",
      properties: { sessionID: "session", info: info("a", prompt, "stop") },
    },
  ]);
  await test.run();
  expect(
    test.events
      .filter((e) => e.type === "TEXT_MESSAGE_CONTENT")
      .map((e) => e.delta)
      .join(""),
  ).toBe("Hi!");
  expect(test.events.at(-1)?.outcome).toEqual({ type: "success" });
  expect(test.transport.abort).not.toHaveBeenCalled();
});
it("does not abort after successful completion even if the caller cancels immediately", async () => {
  const test = setup((prompt) => [
    {
      id: "1",
      type: "message.updated",
      properties: { sessionID: "session", info: info("a", prompt, "stop") },
    },
  ]);
  await test.run();
  test.controller.abort();
  expect(
    test.events.filter((e) => ["RUN_FINISHED", "RUN_ERROR"].includes(e.type)),
  ).toHaveLength(1);
  expect(test.transport.abort).not.toHaveBeenCalled();
});
it("keeps an uncertain active marker when abort fails and rejects replay", async () => {
  const test = setup(() => [], {
    abort: vi.fn(async () => {
      throw new Error("server unavailable");
    }),
  });
  await test.run();
  expect(test.record()?.active).toBeDefined();
  await test.run();
  expect(test.events.at(-1)?.message).toMatch(/recovery/);
  expect(test.transport.prompt).toHaveBeenCalledOnce();
});
it("does not leak connection errors or auth headers before prompt submission", async () => {
  const test = setup(() => [], {
    subscribe: async () => {
      throw new Error("Authorization: secret-key");
    },
  });
  await test.run();
  expect(test.events.at(-1)?.message).toBe("OpenCode run failed");
  expect(test.transport.abort).not.toHaveBeenCalled();
});

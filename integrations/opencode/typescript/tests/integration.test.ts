import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { EventSchemas } from "@ag-ui/core/schemas";
import type { BaseEvent, RunAgentInput } from "@ag-ui/core";
import {
  OpenCodeBridge,
  FileSessionStore,
  createSdkTransport,
  createRequestHandler,
  sessionKey,
} from "../src/server";
import { startFixture } from "../examples/agentic-chat/fixture";

const input = (
  content = "Hello",
  threadId = "thread",
  id = "u1",
): RunAgentInput => ({
  threadId,
  runId: `run-${id}`,
  messages: [{ id, role: "user", content }],
  tools: [],
  context: [],
});
let fixture: Awaited<ReturnType<typeof startFixture>>;
let folder: string;
let bridge: OpenCodeBridge;
let store: FileSessionStore;
const context = { owner: "tenant/user", directory: "/project" };
const eventsFor = async (request: RunAgentInput, options = context) => {
  const events: BaseEvent[] = [];
  await bridge.run(request, options, (e) => {
    expect(EventSchemas.parse(e)).toEqual(e);
    events.push(e);
  });
  expect(events.filter((e) => e.type === "RUN_STARTED")).toHaveLength(1);
  expect(
    events.filter((e) => e.type === "RUN_FINISHED" || e.type === "RUN_ERROR"),
  ).toHaveLength(1);
  return events;
};
function makeBridge(timeoutMs = 2000) {
  return new OpenCodeBridge({
    transport: createSdkTransport({
      baseUrl: fixture.url,
      directory: context.directory,
    }),
    directory: context.directory,
    store,
    timeoutMs,
  });
}
beforeEach(async () => {
  fixture = await startFixture();
  folder = await mkdtemp(join(tmpdir(), "ag-ui-opencode-"));
  store = new FileSessionStore(folder);
  bridge = makeBridge();
});
afterEach(async () => {
  await fixture.close();
  await rm(folder, { recursive: true, force: true });
});

describe("SDK HTTP integration", () => {
  it("streams two turns, rehydrates session ownership and submits only the new message", async () => {
    const first = await eventsFor(input("What is the capital of France?"));
    expect(first.at(-1)?.outcome).toEqual({ type: "success" });
    expect(
      first
        .filter((e) => e.type === "TEXT_MESSAGE_CONTENT")
        .map((e) => e.delta)
        .join(""),
    ).toBe("The capital of France is Paris.");
    bridge = makeBridge();
    const second = input("Remember the previous turn?", "thread", "u2");
    second.messages.unshift(input().messages[0]);
    expect((await eventsFor(second)).at(-1)?.outcome).toEqual({
      type: "success",
    });
    expect(fixture.sessions.size).toBe(1);
    expect(
      [...fixture.sessions.values()][0].filter((m) => m.info.role === "user"),
    ).toHaveLength(2);
    expect((await eventsFor(second)).at(-1)?.type).toBe("RUN_ERROR");
  });
  it("isolates owners and ignores interleaved sessions", async () => {
    const [a, b] = await Promise.all([
      eventsFor(input("France")),
      eventsFor(input("Hello"), { ...context, owner: "other-user" }),
    ]);
    expect(
      a
        .filter((e) => e.type === "TEXT_MESSAGE_CONTENT")
        .map((e) => e.delta)
        .join(""),
    ).toContain("Paris");
    expect(
      b
        .filter((e) => e.type === "TEXT_MESSAGE_CONTENT")
        .map((e) => e.delta)
        .join(""),
    ).not.toContain("Paris");
    expect(fixture.sessions.size).toBe(2);
  });
  it.each(["once", "always", "reject"])(
    "persists permission interrupts and replies %s after a bridge restart",
    async (reply) => {
      const first = await eventsFor(input("[permission]"));
      const outcome = first.at(-1)!.outcome as any;
      expect(outcome.type).toBe("interrupt");
      bridge = makeBridge();
      const request = {
        ...input(),
        resume: [
          {
            interruptId: outcome.interrupts[0].id,
            status: "resolved" as const,
            payload: { reply },
          },
        ],
      };
      const second = await eventsFor(request);
      expect(second.at(-1)?.outcome).toEqual({
        type: reply === "reject" ? "cancelled" : "success",
      });
      if (reply !== "reject")
        expect(
          second
            .filter((e) => e.type === "TEXT_MESSAGE_CONTENT")
            .map((e) => e.delta)
            .join(""),
        ).toContain(reply);
      expect((await eventsFor(request)).at(-1)?.type).toBe("RUN_ERROR");
    },
  );
  it("validates question answers separately from permission decisions", async () => {
    const first = await eventsFor(input("[question]"));
    const interruptId = (first.at(-1)!.outcome as any).interrupts[0].id;
    const invalid = {
      ...input(),
      resume: [
        {
          interruptId,
          status: "resolved" as const,
          payload: { reply: "once" },
        },
      ],
    };
    expect((await eventsFor(invalid)).at(-1)?.type).toBe("RUN_ERROR");
    const valid = {
      ...input(),
      resume: [
        {
          interruptId,
          status: "resolved" as const,
          payload: { answers: [["Blue"]] },
        },
      ],
    };
    expect((await eventsFor(valid)).at(-1)?.outcome).toEqual({
      type: "success",
    });
  });
  it("does not authorize an interrupt for another owner", async () => {
    const first = await eventsFor(input("[permission]"));
    const interruptId = (first.at(-1)!.outcome as any).interrupts[0].id;
    const request = {
      ...input(),
      resume: [
        {
          interruptId,
          status: "resolved" as const,
          payload: { reply: "once" },
        },
      ],
    };
    expect(
      (await eventsFor(request, { ...context, owner: "attacker" })).at(-1)
        ?.type,
    ).toBe("RUN_ERROR");
    expect((await eventsFor(request)).at(-1)?.outcome).toEqual({
      type: "success",
    });
  });
  it("denies cancelled questions without auto approval", async () => {
    const first = await eventsFor(input("[question]"));
    const interruptId = (first.at(-1)!.outcome as any).interrupts[0].id;
    const second = await eventsFor({
      ...input(),
      resume: [{ interruptId, status: "cancelled" }],
    });
    expect(second.at(-1)?.outcome).toEqual({ type: "cancelled" });
  });
  it("rejects concurrent turns without aborting the lock owner", async () => {
    const controller = new AbortController();
    const first: BaseEvent[] = [];
    const running = bridge.run(
      input("[hang]"),
      { ...context, signal: controller.signal },
      (e) => first.push(e),
    );
    // Wait for the fixture to record the submitted turn, not for an arbitrary delay.
    while (!fixture.sessions.size || ![...fixture.sessions.values()][0]?.length)
      await new Promise((r) => setTimeout(r, 5));
    expect(
      (await eventsFor(input("other", "thread", "u2"))).at(-1)?.message,
    ).toMatch(/busy/);
    expect(first.at(-1)?.type).toBe("RUN_STARTED");
    controller.abort();
    await running;
    expect(first.at(-1)?.outcome).toEqual({ type: "cancelled" });
  });
  it("redacts provider errors and terminates timeouts", async () => {
    const error = await eventsFor(input("[error]"));
    expect(error.at(-1)?.type).toBe("RUN_ERROR");
    expect(JSON.stringify(error)).not.toContain("secret provider");
    bridge = makeBridge(50);
    const timeout = await eventsFor(input("[hang]", "timeout"));
    expect(timeout.at(-1)?.code).toBe("TIMEOUT");
  });
  it("expires pending requests without submitting permission replies", async () => {
    const first = await eventsFor(input("[permission]"));
    const key = sessionKey(context.owner, "thread", context.directory);
    const record = (await store.read(key))!;
    record.pending!.expiresAt = new Date(0).toISOString();
    await store.write(key, record);
    const interruptId = (first.at(-1)!.outcome as any).interrupts[0].id;
    expect(
      (
        await eventsFor({
          ...input(),
          resume: [
            { interruptId, status: "resolved", payload: { reply: "always" } },
          ],
        })
      ).at(-1)?.message,
    ).toMatch(/expired/);
    expect((await store.read(key))?.pending).toBeUndefined();
  });
  it("rejects unsupported history, client tools, and multimedia before creating a session", async () => {
    for (const request of [
      {
        ...input(),
        messages: [
          ...input().messages,
          ...input("second", "thread", "u2").messages,
        ],
      },
      {
        ...input(),
        tools: [{ name: "unsafe", description: "unsupported", parameters: {} }],
      },
      {
        ...input(),
        messages: [
          {
            id: "u",
            role: "user",
            content: [{ type: "image", url: "https://example.com/a.png" }],
          },
        ],
      } as any,
    ])
      expect((await eventsFor(request)).at(-1)?.type).toBe("RUN_ERROR");
    expect(fixture.sessions.size).toBe(0);
  });
  it("rejects stale permission and question requests without sending replies", async () => {
    for (const kind of ["permission", "question"]) {
      const first = await eventsFor(input(`[${kind}]`, kind));
      const key = sessionKey(context.owner, kind, context.directory);
      const record = (await store.read(key))!;
      const transport = createSdkTransport({
        baseUrl: fixture.url,
        directory: context.directory,
      });
      await transport.abort(record.sessionID);
      const interruptId = (first.at(-1)!.outcome as any).interrupts[0].id;
      const result = await eventsFor({
        ...input("ignored", kind),
        resume: [
          {
            interruptId,
            status: "resolved",
            payload:
              kind === "permission"
                ? { reply: "once" }
                : { answers: [["Blue"]] },
          },
        ],
      });
      expect(result.at(-1)?.message).toMatch(/stale/);
    }
  });
  it("aborts an HTTP disconnect and preserves a separate active caller", async () => {
    const handler = createRequestHandler({
      bridge,
      directory: context.directory,
      authenticate: async () => context.owner,
    });
    const server = createServer(handler);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/agentic_chat`;
    const controller = new AbortController();
    try {
      const response = await fetch(url, {
        method: "POST",
        body: JSON.stringify(input("[hang]", "disconnect")),
        signal: controller.signal,
      });
      const reader = response.body!.getReader();
      await reader.read();
      const key = sessionKey(context.owner, "disconnect", context.directory);
      await expect
        .poll(async () => !!(await store.read(key))?.active)
        .toBe(true);
      controller.abort();
      await expect
        .poll(async () => (await store.read(key))?.active)
        .toBeUndefined();
      expect(
        (await eventsFor(input("hello", "disconnect", "u2"))).at(-1)?.outcome,
      ).toEqual({ type: "success" });
    } finally {
      controller.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it("serves authenticated encoded SSE and rejects malformed/resume HTTP requests", async () => {
    const handler = createRequestHandler({
      bridge,
      directory: context.directory,
      authenticate: async (req) =>
        req.headers.authorization === "Bearer test" ? context.owner : undefined,
    });
    const server = createServer(handler);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/agentic_chat`;
    try {
      expect((await fetch(url, { method: "POST" })).status).toBe(401);
      expect(
        (
          await fetch(url, {
            method: "POST",
            headers: { Authorization: "Bearer test" },
            body: "bad",
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await fetch(url, {
            method: "POST",
            headers: { Authorization: "Bearer test", "Last-Event-ID": "1" },
            body: JSON.stringify(input()),
          })
        ).status,
      ).toBe(409);
      const response = await fetch(url, {
        method: "POST",
        headers: { Authorization: "Bearer test" },
        body: JSON.stringify(input()),
      });
      expect(response.headers.get("content-type")).toContain(
        "text/event-stream",
      );
      const events = (await response.text())
        .split("\n\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line.slice(6)));
      events.forEach((e) => EventSchemas.parse(e));
      expect(events.at(-1).type).toBe("RUN_FINISHED");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AbstractAgent, buildResumeArray } from "@ag-ui/client";
import type { RunAgentInput } from "@ag-ui/core";
import { ClaudeAgentAdapter } from "./adapter";
const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  query: queryMock,
}));
const dirs: string[] = [];
const session = "11111111-1111-4111-8111-111111111111";
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(
    dirs.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "agui-standard-"));
  dirs.push(root);
  await mkdir(join(root, "project"));
  const path = join(root, "project", session + ".jsonl");
  const calls = [
    { id: "native", name: "Read", input: { file_path: "fixture" } },
    { id: "frontend", name: "mcp__ag_ui__chart", input: { value: 7 } },
  ];
  await writeFile(
    path,
    JSON.stringify({
      type: "assistant",
      uuid: "call-row",
      sessionId: session,
      version: "2.1.306",
      message: {
        role: "assistant",
        content: calls.map((c) => ({ type: "tool_use", ...c })),
      },
    }) + "\n",
  );
  const execute = vi.fn(async () => ({ content: "ACTUAL_NATIVE" }));
  const create = () =>
    new ClaudeAgentAdapter({
      nativeChildRecovery: {
        directory: root,
        tools: ["Read"],
        execute,
        acquire: async () => async () => {},
      },
    });
  let requests = 0;
  class Client extends AbstractAgent {
    run(input: RunAgentInput) {
      requests++;
      return create().run(input);
    }
  }
  const client = new Client({
    threadId: session,
    initialMessages: [
      {
        id: "root",
        role: "assistant",
        toolCalls: calls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: JSON.stringify(c.input) },
        })),
      },
    ],
  });
  const options = {
    tools: [
      {
        name: "chart",
        description: "Render original chart",
        parameters: {
          type: "object",
          properties: { value: { type: "number" } },
        },
      },
    ],
    context: [{ description: "actual context", value: "keep me" }],
    forwardedProps: { resume: session },
  };
  queryMock.mockImplementation(() =>
    Object.assign(
      (async function* () {
        yield {
          type: "result",
          subtype: "success",
          session_id: session,
          stop_reason: "end_turn",
          is_error: false,
          num_turns: 1,
          duration_ms: 1,
          duration_api_ms: 1,
        };
      })(),
      { close: () => {} },
    ),
  );
  return { client, options, path, execute, requests: () => requests };
}
it.each([false, true])(
  "accepts public-client full resume and one actual frontend result (cancelled=%s)",
  async (cancelled) => {
    const { client, options, path, execute, requests } = await fixture();
    await client.runAgent(options);
    expect(client.pendingInterrupts.map((i) => [i.id, i.reason])).toEqual([
      ["native", "tool_approval"],
      ["frontend", "tool_call"],
    ]);
    await expect(
      client.runAgent({
        ...options,
        resume: [
          {
            interruptId: "native",
            status: "resolved",
            payload: { behavior: "allow" },
          },
        ],
      }),
    ).rejects.toThrow(/not addressed/);
    expect(requests()).toBe(1);
    const payload = { displayed: true, value: 7 };
    const resume = buildResumeArray(client.pendingInterrupts, {
      native: { status: "resolved", payload: { behavior: "allow" } },
      frontend: cancelled
        ? { status: "cancelled" }
        : { status: "resolved", payload },
    });
    const content = JSON.stringify(
      cancelled ? { status: "cancelled" } : payload,
    );
    client.addMessage({
      id: "frontend-result",
      role: "tool",
      toolCallId: "frontend",
      content,
    });
    await client.runAgent({ ...options, resume });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(client.pendingInterrupts).toEqual([]);
    const rows = (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .map((s) => JSON.parse(s));
    const results = rows
      .flatMap((r) => (r.type === "user" ? r.message.content : []))
      .filter((b) => b.tool_use_id === "frontend");
    expect(results).toEqual([
      {
        type: "tool_result",
        tool_use_id: "frontend",
        content,
        is_error: cancelled,
      },
    ]);
    // A fresh adapter behind the same public client reuses canonical results.
    await client.runAgent({ ...options, resume });
    expect(execute).toHaveBeenCalledTimes(1);
  },
);
it.each(["conflict", "missing", "native-pair"])(
  "rejects %s before any native execution",
  async (kind) => {
    const { client, options, execute, path } = await fixture();
    await client.runAgent(options);
    const before = await readFile(path, "utf8");
    const payload = { displayed: true, value: 7 };
    if (kind !== "missing")
      client.addMessage({
        id: "frontend-result",
        role: "tool",
        toolCallId: "frontend",
        content: JSON.stringify(
          kind === "conflict" ? { displayed: false } : payload,
        ),
      });
    if (kind === "native-pair")
      client.addMessage({
        id: "native-result",
        role: "tool",
        toolCallId: "native",
        content: "UNTRUSTED",
      });
    const resume = buildResumeArray(client.pendingInterrupts, {
      native: { status: "resolved", payload: { behavior: "allow" } },
      frontend: { status: "resolved", payload },
    });
    const errors: string[] = [];
    await client.runAgent(
      { ...options, resume },
      {
        onRunErrorEvent: ({ event }) => {
          errors.push(event.message);
        },
      },
    );
    expect(errors).toHaveLength(1);
    expect(execute).not.toHaveBeenCalled();
    expect(await readFile(path, "utf8")).toBe(before);
  },
);

it("retries stale client interrupts after downstream failure without executing saved answers again", async () => {
  const { client, options, execute, path } = await fixture();
  await client.runAgent(options);
  const payload = { displayed: true, value: 7 };
  const resume = buildResumeArray(client.pendingInterrupts, {
    native: { status: "resolved", payload: { behavior: "allow" } },
    frontend: { status: "resolved", payload },
  });
  client.addMessage({
    id: "frontend-result",
    role: "tool",
    toolCallId: "frontend",
    content: JSON.stringify(payload),
  });
  queryMock.mockImplementationOnce(() =>
    Object.assign(
      (async function* () {
        throw new Error("downstream timeout after saved answers");
        yield;
      })(),
      { close: () => {} },
    ),
  );
  const errors: string[] = [];
  await client.runAgent(
    { ...options, resume },
    {
      onRunErrorEvent: ({ event }) => {
        errors.push(event.message);
      },
    },
  );
  expect(errors).toHaveLength(1);
  expect(execute).toHaveBeenCalledTimes(1);
  expect(
    client.messages.some((m) => m.role === "tool" && m.toolCallId === "native"),
  ).toBe(true);
  const before = await readFile(path, "utf8");
  await client.runAgent(
    { ...options, resume },
    {
      onRunErrorEvent: ({ event }) => {
        errors.push(event.message);
      },
    },
  );
  expect(errors).toHaveLength(1);
  expect(client.pendingInterrupts).toEqual([]);
  expect(execute).toHaveBeenCalledTimes(1);
  expect(await readFile(path, "utf8")).toBe(before);
});

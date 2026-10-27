import type { RunAgentInput } from "@ag-ui/core";
import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeHistory } from "./native-history";
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(() => {
    throw new Error("Unexpected SDK startup");
  }),
}));
const dirs: string[] = [];
const session = "11111111-1111-4111-8111-111111111111";
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "agui-native-"));
  dirs.push(root);
  const project = join(root, "project");
  await mkdir(join(project, session, "subagents"), { recursive: true });
  const parent = {
    type: "assistant",
    uuid: "parent-row",
    sessionId: session,
    version: "2.1.306",
    message: {
      role: "assistant",
      content: [
        { type: "tool_use", id: "parent-call", name: "Agent", input: {} },
      ],
    },
  };
  const child = {
    type: "assistant",
    uuid: "child-row",
    sessionId: session,
    agentId: "abc123",
    isSidechain: true,
    version: "2.1.306",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "question",
          name: "Read",
          input: { file_path: "/fixture" },
        },
      ],
    },
  };
  await writeFile(
    join(project, session + ".jsonl"),
    JSON.stringify(parent) + "\n",
  );
  const path = join(project, session, "subagents", "agent-abc123.jsonl");
  await writeFile(path, JSON.stringify(child) + "\n");
  return { root, path, history: new NativeHistory(root, session, ["Read"]) };
}
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});
it("reconstructs unanswered questions without event storage and persists actual answers", async () => {
  const { root, path, history } = await fixture();
  const before = await readFile(path, "utf8");
  const first = await history.inspect();
  expect(first?.pending.map((t) => t.id)).toEqual(["question"]);
  expect(
    (await new NativeHistory(root, session, ["Read"]).inspect())?.pending,
  ).toEqual(first?.pending);
  expect(await readFile(path, "utf8")).toBe(before);
  await history.answer(first!, {
    question: { content: "REAL RESULT", is_error: false },
  });
  const restored = await new NativeHistory(root, session, ["Read"]).inspect();
  expect(restored?.pending).toEqual([]);
  expect(await readFile(path, "utf8")).toContain("REAL RESULT");
  await expect(
    history.answer(first!, { question: { content: "duplicate" } }),
  ).rejects.toThrow();
});
it("does not mistake an interrupted result for an answer", async () => {
  const { path, history } = await fixture();
  await writeFile(
    path,
    JSON.stringify({
      type: "user",
      uuid: "interrupted",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "question",
            is_error: true,
            content: "[Tool call interrupted: outcome unknown]",
          },
        ],
      },
    }) + "\n",
    { flag: "a" },
  );
  expect((await history.inspect())?.pending.map((t) => t.id)).toEqual([
    "question",
  ]);
});
it("rejects ambiguous children and unsafe session identifiers", async () => {
  const { root, path, history } = await fixture();
  await writeFile(path.replace("abc123", "def456"), await readFile(path));
  await expect(history.inspect()).rejects.toThrow(
    /one child|identity mismatch/,
  );
  expect(() => new NativeHistory(root, "../escape", ["Read"])).toThrow(
    /session/,
  );
});
it("repairs only the original parent result after durable child completion", async () => {
  const { root, path, history } = await fixture();
  const checkpoint = (await history.inspect())!;
  await history.answer(checkpoint, {
    question: { content: "DENIED", is_error: true },
  });
  await expect(history.repair(checkpoint)).rejects.toThrow(/not completed/);
  await writeFile(
    path,
    JSON.stringify({
      type: "assistant",
      uuid: "final-row",
      sessionId: session,
      agentId: "abc123",
      version: "2.1.306",
      message: {
        role: "assistant",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Child respected the denial" }],
      },
    }) + "\n",
    { flag: "a" },
  );
  await history.repair(checkpoint);
  expect(await history.inspect()).toBeUndefined();
  const parent = await readFile(
    join(root, "project", session + ".jsonl"),
    "utf8",
  );
  expect(parent).toContain("Child respected the denial");
  expect(await readFile(path, "utf8")).toContain('"is_error":true');
});
it("accepts an empty completed child response", async () => {
  const { path, history } = await fixture();
  const checkpoint = (await history.inspect())!;
  await history.answer(checkpoint, { question: { content: "" } });
  await writeFile(
    path,
    JSON.stringify({
      type: "assistant",
      uuid: "empty-final",
      version: "2.1.306",
      message: { role: "assistant", stop_reason: "end_turn", content: [] },
    }) + "\n",
    { flag: "a" },
  );
  expect(await history.completed(checkpoint)).toBe(true);
  await history.repair(checkpoint);
  expect(await history.inspect()).toBeUndefined();
});

it.each([false, true])(
  "blocks cold recovery with a lost bridge result (placeholder=%s)",
  async (placeholder) => {
    const { root, path, history } = await fixture();
    const checkpoint = (await history.inspect())!;
    await history.answer(checkpoint, { question: { content: "REAL RESULT" } });
    await writeFile(
      path,
      JSON.stringify({
        type: "assistant",
        uuid: "final",
        message: {
          role: "assistant",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "DONE" }],
        },
      }) + "\n",
      { flag: "a" },
    );
    await writeFile(
      checkpoint.parentPath,
      JSON.stringify({
        type: "assistant",
        uuid: "bridge",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "bridge-call",
              name: "SendMessage",
              input: {
                to: checkpoint.childId,
                message:
                  "Continue the original task using the recorded tool results. Do not repeat completed tools.",
              },
            },
          ],
        },
      }) + "\n",
      { flag: "a" },
    );
    if (placeholder)
      await writeFile(
        checkpoint.parentPath,
        JSON.stringify({
          type: "user",
          uuid: "unknown",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "bridge-call",
                is_error: true,
                content: "[Tool call interrupted: outcome unknown]",
              },
            ],
          },
        }) + "\n",
        { flag: "a" },
      );
    const before = await readFile(checkpoint.parentPath, "utf8");
    const { NativeChildRecovery } = await import("./native-recovery");
    const release = vi.fn(async () => {});
    const execute = vi.fn();
    const recovery = new NativeChildRecovery({
      directory: root,
      tools: ["Read"],
      execute,
      acquire: async () => release,
    });
    const input: RunAgentInput = {
      threadId: "thread",
      runId: "run",
      messages: [],
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
    };
    await expect(async () => {
      for await (const _ of recovery.run(
        input,
        { resume: session },
        "continue",
      )) {
      }
    }).rejects.toThrow(/Unresolved recovery tool result/);
    expect(execute).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
    expect(await readFile(checkpoint.parentPath, "utf8")).toBe(before);
    // A result observed by the hook can be settled; an unknown one cannot be invented.
    await history.settleBridge(checkpoint, {
      "bridge-call": { content: "ACTUAL SEND RESPONSE" },
    });
    await history.repair(checkpoint);
    expect(await history.inspect()).toBeUndefined();
  },
);

it("preserves diagnostic call/result copies without interpreting or repairing them", async () => {
  const { path, history } = await fixture();
  const checkpoint = (await history.inspect())!;
  const snapshots = new Map<string, string[]>();
  for (const file of [checkpoint.parentPath, path]) {
    const callRow = JSON.parse((await readFile(file, "utf8")).trim());
    const call = callRow.message.content[0];
    const diagnostic = [
      {
        type: "api-request-blob",
        message: {
          role: "assistant",
          content: [{ ...call, caller: { type: "direct" } }],
        },
      },
      {
        type: "api-request-blob",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: call.id,
              content: "DIAGNOSTIC ONLY",
            },
          ],
        },
      },
      {
        type: "api-request-blob",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: call.id,
              content: "[Tool call interrupted: diagnostic]",
              is_error: true,
            },
          ],
        },
      },
    ].map((row) => JSON.stringify(row));
    snapshots.set(file, diagnostic);
    await writeFile(file, diagnostic.join("\n") + "\n", { flag: "a" });
  }
  expect((await history.inspect())?.pending.map((c) => c.id)).toEqual([
    "question",
  ]);
  await history.answer(checkpoint, { question: { content: "ACTUAL" } });
  await writeFile(
    path,
    JSON.stringify({
      type: "assistant",
      uuid: "final",
      message: {
        role: "assistant",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "DONE" }],
      },
    }) + "\n",
    { flag: "a" },
  );
  await history.repair(checkpoint);
  expect(await history.inspect()).toBeUndefined();
  for (const [file, diagnostic] of snapshots) {
    const saved = (await readFile(file, "utf8")).trim().split("\n");
    expect(
      saved.filter((line) => JSON.parse(line).type === "api-request-blob"),
    ).toEqual(diagnostic);
  }
});

it("repairs a nested Agent result with its owner's native sidechain identity", async () => {
  const { path, history } = await fixture();
  const original = JSON.parse((await readFile(path, "utf8")).trim());
  original.message.content = [
    { type: "tool_use", id: "inner", name: "Agent", input: {} },
  ];
  await writeFile(path, JSON.stringify(original) + "\n");
  await writeFile(
    path.replace(".jsonl", ".meta.json"),
    JSON.stringify({ toolUseId: "parent-call" }),
  );
  const leafPath = path.replace("abc123", "leaf");
  await writeFile(
    leafPath,
    JSON.stringify({
      ...original,
      uuid: "leaf-row",
      agentId: "leaf",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "leaf-read",
            name: "Read",
            input: { file_path: "fixture" },
          },
        ],
      },
    }) + "\n",
  );
  await writeFile(
    leafPath.replace(".jsonl", ".meta.json"),
    JSON.stringify({ toolUseId: "inner", parentAgentId: "abc123" }),
  );
  const checkpoints = await history.children();
  expect(checkpoints.find((c) => c.childId === "abc123")?.dependencies).toEqual(
    ["inner"],
  );
  const leaf = checkpoints.find((c) => c.childId === "leaf")!;
  await history.answer(leaf, { "leaf-read": { content: "ACTUAL" } });
  await writeFile(
    leafPath,
    JSON.stringify({
      type: "assistant",
      uuid: "leaf-final",
      agentId: "leaf",
      message: {
        role: "assistant",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "LEAF DONE" }],
      },
    }) + "\n",
    { flag: "a" },
  );
  await history.repair(leaf);
  const result = JSON.parse(
    (await readFile(path, "utf8")).trim().split("\n").at(-1)!,
  );
  expect(result).toMatchObject({
    agentId: "abc123",
    isSidechain: true,
    sourceToolAssistantUUID: "child-row",
  });
  expect(result.message.content[0]).toMatchObject({
    tool_use_id: "inner",
    content: "LEAF DONE",
  });
  expect((await history.children()).map((c) => c.childId)).toEqual(["abc123"]);
  expect((await history.children(true)).length).toBe(2);
});

it("rejects a child metadata parent that disagrees with the canonical owner", async () => {
  const { path, history } = await fixture();
  await writeFile(
    path.replace(".jsonl", ".meta.json"),
    JSON.stringify({ toolUseId: "parent-call", parentAgentId: "other" }),
  );
  await expect(history.children()).rejects.toThrow("parent identity mismatch");
});
it("validates answers before automatic state recovery and acknowledges state only once", async () => {
  const { root, path } = await fixture();
  const row = JSON.parse((await readFile(path, "utf8")).trim());
  row.message.content.push({
    type: "tool_use",
    id: "state",
    name: "internal_state",
    input: { state_updates: { count: 2 } },
  });
  await writeFile(path, JSON.stringify(row) + "\n");
  const before = await readFile(path, "utf8");
  const { NativeChildRecovery } = await import("./native-recovery");
  const automatic = vi.fn(async () => ({ content: "Actual acknowledgement" }));
  const execute = vi.fn();
  const release = vi.fn(async () => {});
  const config = {
    directory: root,
    tools: ["Read"],
    execute,
    acquire: async () => release,
  };
  const input: RunAgentInput = {
    threadId: "t",
    runId: "r",
    messages: [],
    tools: [],
    context: [],
    state: {},
    forwardedProps: {},
  };
  for (const id of ["unknown", "state"]) {
    const recovery = new NativeChildRecovery(config, {
      internal_state: automatic,
    });
    await expect(async () => {
      for await (const _ of recovery.run(
        {
          ...input,
          resume: [
            {
              interruptId: id,
              status: "resolved",
              payload: { behavior: "allow" },
            },
          ],
        },
        { resume: session },
        "continue",
      )) {
      }
    }).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(before);
  }
  expect(automatic).not.toHaveBeenCalled();
  expect(execute).not.toHaveBeenCalled();
  for (let i = 0; i < 2; i++) {
    const recovery = new NativeChildRecovery(config, {
      internal_state: automatic,
    });
    for await (const _ of recovery.run(
      input,
      { resume: session },
      "continue",
    )) {
    }
    expect(recovery.outcome).toMatchObject({
      type: "interrupt",
      interrupts: [{ id: "question" }],
    });
  }
  expect(automatic).toHaveBeenCalledTimes(1);
  expect(execute).not.toHaveBeenCalled();
  expect(release).toHaveBeenCalledTimes(4);
});

it("retires only the answered defer attachment and retains its provenance", async () => {
  const { path, history } = await fixture();
  const marker = {
    type: "attachment",
    uuid: "deferred",
    parentUuid: "child-row",
    attachment: { type: "hook_deferred_tool", toolUseID: "question" },
  };
  await writeFile(
    path,
    JSON.stringify(marker) +
      "\n" +
      JSON.stringify({
        type: "attachment",
        uuid: "snapshot",
        parentUuid: "deferred",
        attachment: { type: "prompt_snapshot" },
      }) +
      "\n",
    { flag: "a" },
  );
  const cp = (await history.inspect())!;
  await history.answer(cp, { question: { content: "ACTUAL" } });
  const rows = (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .map((s) => JSON.parse(s));
  expect(rows.some((r) => r.attachment?.type === "hook_deferred_tool")).toBe(
    false,
  );
  expect(rows.find((r) => r.uuid === "snapshot").parentUuid).toBe("child-row");
  expect(rows.at(-1).agUiResolvedDeferrals).toEqual([marker]);
  expect(rows.at(-1).message.content[0]).toMatchObject({
    tool_use_id: "question",
    content: "ACTUAL",
  });
});

it("rejects a retransmission that changes the canonical result error status", async () => {
  const { root, history } = await fixture();
  await history.answer((await history.inspect())!, {
    question: { content: "ACTUAL" },
  });
  const { NativeChildRecovery } = await import("./native-recovery");
  const recovery = new NativeChildRecovery({
    directory: root,
    tools: ["Read"],
    execute: vi.fn(),
    acquire: async () => async () => {},
  });
  const input: RunAgentInput = {
    threadId: "t",
    runId: "r",
    messages: [
      {
        id: "result",
        role: "tool",
        toolCallId: "question",
        content: "ACTUAL",
        error: "changed",
      },
    ],
    tools: [],
    context: [],
    state: {},
    forwardedProps: {},
  };
  await expect(async () => {
    for await (const _ of recovery.run(
      input,
      { resume: session },
      "continue",
    )) {
    }
  }).rejects.toThrow("differs from canonical history");
});

it.each([
  "valid",
  "wrong-target",
  "wrong-message",
  "no-receipt",
  "failed-receipt",
  "no-prompt",
])("supersedes only a verified recovery delivery: %s", async (variant) => {
  const { path, history } = await fixture();
  const cp = (await history.inspect())!;
  await history.answer(cp, { question: { content: "ACTUAL" } });
  await writeFile(
    path,
    JSON.stringify({
      type: "assistant",
      uuid: "final",
      message: {
        role: "assistant",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "DONE" }],
      },
    }) + "\n",
    { flag: "a" },
  );
  const message =
    "Continue the original task using the recorded tool results. Do not repeat completed tools.";
  const unknown = {
    type: "tool_result",
    tool_use_id: "old-bridge",
    is_error: true,
    content: "[Tool call interrupted: outcome unknown]",
  };
  const records: any[] = [];
  for (const key of ["old-bridge", "new-bridge"]) {
    const target =
      variant === "wrong-target" && key === "new-bridge"
        ? "different-child"
        : cp.childId;
    const text =
      variant === "wrong-message" && key === "new-bridge"
        ? "another message"
        : message;
    records.push(
      {
        type: "user",
        uuid: key + "-prompt",
        message: {
          role: "user",
          content:
            variant === "no-prompt"
              ? "not recovery"
              : `Resume child ${target} with SendMessage, message exactly: ${text}`,
        },
      },
      {
        type: "assistant",
        uuid: key,
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: key,
              name: "SendMessage",
              input: { to: target, message: text },
            },
          ],
        },
      },
    );
    if (variant === "no-receipt" && key === "new-bridge") continue;
    records.push({
      type: "user",
      uuid: key + "-result",
      message: {
        role: "user",
        content: [
          key === "old-bridge"
            ? unknown
            : {
                type: "tool_result",
                tool_use_id: key,
                is_error: variant === "failed-receipt",
                content: JSON.stringify({
                  success: true,
                  resumedAgentId: target,
                }),
              },
        ],
      },
    });
  }
  await writeFile(
    cp.parentPath,
    records.map((r) => JSON.stringify(r) + "\n").join(""),
    { flag: "a" },
  );
  const before = await readFile(cp.parentPath, "utf8");
  if (variant !== "valid") {
    await expect(history.repair(cp)).rejects.toThrow(/Unresolved recovery/);
    expect(await readFile(cp.parentPath, "utf8")).toBe(before);
    return;
  }
  await history.repair(cp);
  await history.assertRootReady();
  expect(await history.inspect()).toBeUndefined();
  const saved = (await readFile(cp.parentPath, "utf8"))
    .trim()
    .split("\n")
    .map((r) => JSON.parse(r))
    .flatMap((r) =>
      Array.isArray(r.message?.content) ? r.message.content : [],
    )
    .filter((b) => b.tool_use_id === "old-bridge");
  expect(saved).toEqual([unknown]);
});

import {
  getSessionMessages,
  type SessionStore,
} from "@anthropic-ai/claude-agent-sdk";
import { describe, it, expect } from "vitest";
import { RecoveryRun, historicalToolResults } from "./recovery";
import type { RunAgentInput } from "@ag-ui/core";
const pending = {
  id: "call-original",
  name: "Bash",
  input: { command: "echo test" },
};
const input = (behavior?: "allow" | "deny"): RunAgentInput => ({
  threadId: "thread",
  runId: "run",
  messages: [],
  tools: [],
  context: [],
  state: {},
  forwardedProps: {},
  ...(behavior
    ? {
        resume: [
          {
            interruptId: pending.id,
            status: "resolved",
            payload: { behavior },
          },
        ],
      }
    : {}),
});
const hookInput = {
  hook_event_name: "PreToolUse" as const,
  tool_use_id: pending.id,
  tool_name: pending.name,
  tool_input: pending.input,
  session_id: "native",
  transcript_path: "/test",
  cwd: "/test",
};
describe("durable SDK deferral", () => {
  for (const behavior of ["allow", "deny"] as const)
    it(`resumes original call with ${behavior} after restart`, async () => {
      const first = new RecoveryRun(undefined, input());
      first.observe("native", "original-profile", {
        stop_reason: "tool_deferred",
        deferred_tool_use: pending,
      });
      const restored = new RecoveryRun(
        structuredClone(first.binding),
        input(behavior),
      );
      expect(
        await restored.hook(hookInput, pending.id, {
          signal: new AbortController().signal,
        }),
      ).toMatchObject({ hookSpecificOutput: { permissionDecision: behavior } });
      expect(restored.binding?.pending?.id).toBe(pending.id);
      restored.observe("native", "original-profile", {});
      expect(restored.binding).toEqual({
        sessionId: "native",
        profile: "original-profile",
      });
      expect(() => new RecoveryRun(restored.binding, input(behavior))).toThrow(
        "No saved SDK deferral",
      );
    });
  it("keeps unanswered deferrals actionable and rejects changed UUID", () => {
    const run = new RecoveryRun(
      { sessionId: "native", profile: "original", pending },
      input(),
    );
    expect(run.awaitingDecision).toBe(true);
    expect(run.interrupts[0].id).toBe(pending.id);
    expect(() => run.observe("replacement", "original")).toThrow("UUID");
  });
  it("does not recover callback history or parallel approvals", () => {
    expect(
      () =>
        new RecoveryRun(
          { sessionId: "native", profile: "original" },
          input("allow"),
        ),
    ).toThrow("No saved SDK deferral");
    const request = input("allow");
    request.resume!.push(request.resume![0]);
    expect(
      () =>
        new RecoveryRun(
          { sessionId: "native", profile: "original", pending },
          request,
        ),
    ).toThrow("one tool call");
  });
  it("does not consume a mismatched tool or unavailable tool", async () => {
    const run = new RecoveryRun(
      { sessionId: "native", profile: "original", pending },
      input("allow"),
    );
    expect(
      await run.hook({ ...hookInput, tool_input: {} }, pending.id, {
        signal: new AbortController().signal,
      }),
    ).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    expect(() => run.observe("native", "original", {})).toThrow(
      "does not match",
    );
    const unavailable = new RecoveryRun(
      { sessionId: "native", profile: "original", pending },
      input("allow"),
    );
    expect(() =>
      unavailable.observe("native", "original", {
        stop_reason: "tool_deferred_unavailable",
        is_error: true,
      }),
    ).toThrow("unavailable");
    expect(run.binding?.pending).toEqual(pending);
  });
});
it("does not reopen an answered approval if the model subsequently fails", async () => {
  const run = new RecoveryRun(
    { sessionId: "native", profile: "profile", pending },
    input("allow"),
  );
  await run.hook(hookInput, pending.id, {
    signal: new AbortController().signal,
  });
  expect(run.observeToolResult(pending.id)).toBe(true);
  run.observe("native", "profile", { is_error: true });
  expect(run.binding?.pending).toBeUndefined();
});

it("restores middleware error metadata with the original payload after client reduction", async () => {
  const deferred = { id: "mcp-call", name: "mcp__ag_ui__draw", input: {} };
  const run = new RecoveryRun(
    { sessionId: "native", profile: "profile", pending: deferred },
    {
      ...input(),
      messages: [
        {
          id: "result",
          role: "tool",
          toolCallId: deferred.id,
          content: "original MCP error",
          metadata: { "ag-ui:tool-result": { error: "" } },
        },
      ],
    },
  );
  await run.hook(
    {
      ...hookInput,
      tool_use_id: deferred.id,
      tool_name: deferred.name,
      tool_input: {},
    },
    deferred.id,
    { signal: new AbortController().signal },
  );
  expect(run.resolveFrontendResult("draw", {})).toEqual({
    content: "original MCP error",
    error: "",
  });
  expect(() => run.resolveFrontendResult("draw", {})).toThrow(
    "no matching resumed result",
  );
});
const stateResult = {
  id: "state-call-result",
  role: "tool" as const,
  toolCallId: "state-call",
  content: "State updated successfully",
};
function mixedInput(behavior?: "allow" | "deny"): RunAgentInput {
  return {
    ...input(behavior),
    state: { todos: [{ title: "Persist across reload" }] },
    // Captured input order: the state call is hidden, its result trails Read.
    messages: [
      {
        id: "native-call",
        role: "assistant",
        toolCalls: [
          {
            id: pending.id,
            type: "function",
            function: {
              name: pending.name,
              arguments: JSON.stringify(pending.input),
            },
          },
        ],
      },
      stateResult,
    ],
  };
}
for (const behavior of ["allow", "deny"] as const)
  it(`accepts verified historical state results with native ${behavior}`, async () => {
    const request = mixedInput(behavior);
    const before = structuredClone(request);
    const run = new RecoveryRun(
      {
        sessionId: "native",
        profile: "original",
        pending: structuredClone(pending),
      },
      request,
      [],
      [stateResult],
    );
    expect(
      await run.hook(hookInput, pending.id, {
        signal: new AbortController().signal,
      }),
    ).toMatchObject({ hookSpecificOutput: { permissionDecision: behavior } });
    expect(run.observeToolResult(pending.id)).toBe(true);
    expect(run.observeToolResult(pending.id)).toBe(false);
    run.observe("native", "original", { is_error: true });
    expect(run.binding).toEqual({ sessionId: "native", profile: "original" });
    expect(request).toEqual(before);
    const reloaded = new RecoveryRun(
      structuredClone(run.binding),
      mixedInput(),
      [],
      [stateResult],
    );
    expect(reloaded.awaitingDecision).toBe(false);
    expect(
      () => new RecoveryRun(run.binding, request, [], [stateResult]),
    ).toThrow("No saved SDK deferral");
  });

it("rejects unverified, changed, duplicate and conflicting results in mixed history", () => {
  const binding = { sessionId: "native", profile: "original", pending };
  for (const result of [
    stateResult,
    { ...stateResult, content: "changed" },
    { ...stateResult, error: "changed" },
  ]) {
    const request = mixedInput("allow");
    request.messages[1] = result;
    expect(
      () =>
        new RecoveryRun(
          binding,
          request,
          [],
          result === stateResult ? [] : [stateResult],
        ),
    ).toThrow("No saved SDK deferral");
  }
  const duplicate = mixedInput("allow");
  duplicate.messages.push(stateResult);
  expect(() => new RecoveryRun(binding, duplicate, [], [stateResult])).toThrow(
    "Multiple results",
  );
  const conflicting = mixedInput("allow");
  conflicting.messages.push({ ...stateResult, toolCallId: pending.id });
  expect(
    () => new RecoveryRun(binding, conflicting, [], [stateResult]),
  ).toThrow("either a native decision");
  const wrong = mixedInput("allow");
  wrong.resume![0].interruptId = "wrong";
  expect(() => new RecoveryRun(binding, wrong, [], [stateResult])).toThrow(
    "No saved SDK deferral matches this approval",
  );
});

it("cold-restores legacy bindings using trusted transcript results, including pending reloads", async () => {
  const binding = { sessionId: "native", profile: "original", pending };
  let reads = 0;
  const loadHistory = async () => {
    reads++;
    return [stateResult];
  };
  const waiting = await RecoveryRun.restore(
    binding,
    mixedInput(),
    [],
    loadHistory,
  );
  expect(waiting.awaitingDecision).toBe(true);
  const approved = await RecoveryRun.restore(
    binding,
    mixedInput("allow"),
    [],
    loadHistory,
  );
  expect(approved.resuming).toBe(true);
  expect(reads).toBe(2);
  const wrong = mixedInput("allow");
  wrong.resume![0].interruptId = "wrong";
  await expect(
    RecoveryRun.restore(binding, wrong, [], loadHistory),
  ).rejects.toThrow("matches this approval");
  expect(reads).toBe(2);
  await expect(
    RecoveryRun.restore(binding, mixedInput("allow"), [], async () => []),
  ).rejects.toThrow("matches this frontend result");
  await expect(
    RecoveryRun.restore(binding, mixedInput("allow"), [], async () => {
      throw new Error("unreadable transcript");
    }),
  ).rejects.toThrow("unreadable transcript");
});

it("verifies legacy state history through the real SDK session-store reader", async () => {
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const store: SessionStore = {
    append: async () => {
      throw new Error("History verification must not write");
    },
    load: async (key) => {
      expect(key).toEqual({ projectKey: "-original", sessionId });
      return [
        {
          type: "user",
          uuid: "user",
          parentUuid: null,
          sessionId,
          message: { role: "user", content: "Update state then read" },
        },
        {
          type: "assistant",
          uuid: "state",
          parentUuid: "user",
          sessionId,
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "state-call",
                name: "mcp__ag_ui__ag_ui_update_state",
                input: {},
              },
            ],
          },
        },
        {
          type: "user",
          uuid: "result",
          parentUuid: "state",
          sessionId,
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "state-call",
                content: [{ type: "text", text: "State updated successfully" }],
              },
            ],
          },
        },
      ];
    },
  };
  const run = await RecoveryRun.restore(
    { sessionId, profile: "original", pending },
    mixedInput("allow"),
    [],
    async () =>
      historicalToolResults(
        await getSessionMessages(sessionId, {
          dir: "/original",
          sessionStore: store,
        }),
      ),
  );
  expect(run.resuming).toBe(true);
  expect(run.binding?.sessionId).toBe(sessionId);
});

it("accepts a verified native historical error carried only in client metadata", async () => {
  const history = historicalToolResults([
    {
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "state-call",
            content: "Permission denied",
            is_error: true,
          },
        ],
      },
    },
  ]);
  const request = mixedInput("allow");
  const result = {
    ...history[0],
    error: undefined,
    metadata: { "ag-ui:tool-result": { error: "Tool execution failed" } },
  };
  request.messages[1] = result;
  const binding = { sessionId: "native", profile: "original", pending };
  const run = await RecoveryRun.restore(
    binding,
    request,
    [],
    async () => history,
  );
  expect(
    await run.hook(hookInput, pending.id, {
      signal: new AbortController().signal,
    }),
  ).toMatchObject({ hookSpecificOutput: { permissionDecision: "allow" } });
  for (const invalid of [
    { ...result, content: "changed" },
    { ...result, error: "different explicit error" },
    {
      ...result,
      metadata: { "ag-ui:tool-result": { error: "different metadata error" } },
    },
    { ...result, metadata: { "ag-ui:tool-result": { error: true } } },
    { ...result, metadata: { "ag-ui:tool-result": null } },
  ]) {
    await expect(
      RecoveryRun.restore(
        binding,
        { ...request, messages: [invalid] },
        [],
        async () => history,
      ),
    ).rejects.toThrow("matches this frontend result");
  }
});

it.each([false, true])(
  "requires native results for parallel siblings (completed=%s)",
  async (completed) => {
    const meeting = {
      id: "meeting",
      name: "mcp__ag_ui__scheduleTime",
      input: { duration: 30 },
    };
    const binding = {
      sessionId: "native",
      profile: "original",
      pending: meeting,
    };
    const request: RunAgentInput = {
      ...input(),
      messages: [
        { id: "pie-result", role: "tool", toolCallId: "pie", content: "" },
        { id: "bar-result", role: "tool", toolCallId: "bar", content: "" },
        {
          id: "meeting-result",
          role: "tool",
          toolCallId: "meeting",
          content: "Meeting declined",
        },
      ],
    };
    const history = historicalToolResults([
      {
        message: {
          content: [
            {
              type: "tool_use",
              id: "pie",
              name: "mcp__ag_ui__pieChart",
              input: {},
            },
            {
              type: "tool_use",
              id: "bar",
              name: "mcp__ag_ui__barChart",
              input: {},
            },
            {
              type: "tool_use",
              id: meeting.id,
              name: meeting.name,
              input: meeting.input,
            },
            ...(completed
              ? ["pie", "bar"].map((id) => ({
                  type: "tool_result",
                  tool_use_id: id,
                  content: [{ type: "text", text: "" }],
                }))
              : []),
          ],
        },
      },
    ]);
    const restored = RecoveryRun.restore(
      binding,
      request,
      [],
      async () => history,
    );
    if (!completed) {
      // Native tool_use records alone do not prove that sibling replies were delivered.
      await expect(restored).rejects.toThrow("matches this frontend result");
      expect(binding.pending).toEqual(meeting);
      return;
    }
    const run = await restored;
    await run.hook(
      {
        ...hookInput,
        tool_use_id: meeting.id,
        tool_name: meeting.name,
        tool_input: meeting.input,
      },
      meeting.id,
      { signal: new AbortController().signal },
    );
    expect(run.resolveFrontendResult("scheduleTime", meeting.input)).toEqual({
      content: "Meeting declined",
    });
    expect(() =>
      run.resolveFrontendResult("scheduleTime", meeting.input),
    ).toThrow("no matching resumed result");
    expect(run.observeToolResult(meeting.id)).toBe(true);
    expect(run.binding?.pending).toBeUndefined();
  },
);
it("restores middleware error metadata with the original payload after client reduction", async () => {
  const deferred = { id: "mcp-call", name: "mcp__ag_ui__draw", input: {} };
  const run = new RecoveryRun(
    { sessionId: "native", profile: "profile", pending: deferred },
    {
      ...input(),
      messages: [
        {
          id: "result",
          role: "tool",
          toolCallId: deferred.id,
          content: "original MCP error",
          metadata: { "ag-ui:tool-result": { error: "" } },
        },
      ],
    },
  );
  await run.hook(
    {
      ...hookInput,
      tool_use_id: deferred.id,
      tool_name: deferred.name,
      tool_input: {},
    },
    deferred.id,
    { signal: new AbortController().signal },
  );
  expect(run.resolveFrontendResult("draw", {})).toEqual({
    content: "original MCP error",
    error: "",
  });
  expect(() => run.resolveFrontendResult("draw", {})).toThrow(
    "no matching resumed result",
  );
});

it("retains every deferred sibling and refuses cold batch continuation", async () => {
  const run = new RecoveryRun(undefined, input(), ["Bash"]);
  const calls = [0, 1, 2].map((n) => ({
    ...pending,
    id: `batch-${n}`,
    input: { command: `echo ${n}` },
  }));
  for (const call of calls)
    await run.hook(
      { ...hookInput, tool_use_id: call.id, tool_input: call.input },
      call.id,
      { signal: new AbortController().signal },
    );
  run.observe("native", "profile", {
    stop_reason: "tool_deferred",
    deferred_tool_use: calls[2],
  });
  expect(run.binding?.unsupportedPendingTools).toEqual(calls);
  expect(() => run.assertSupported()).toThrow("multiple pending tool calls");
  const saved = structuredClone(run.binding);
  expect(() => new RecoveryRun(saved, input())).toThrow(
    "multiple pending tool calls",
  );
  expect(saved).toEqual(run.binding);
});

it("finds unresolved native siblings without treating completed empty results as pending", async () => {
  const { unresolvedToolUses } = await import("./recovery");
  const calls = [0, 1, 2].map((i) => ({
    type: "tool_use",
    ...pending,
    id: `call-${i}`,
  }));
  const history = [
    { message: { content: calls } },
    {
      message: {
        content: [{ type: "tool_result", tool_use_id: "call-0", content: "" }],
      },
    },
  ];
  expect(unresolvedToolUses(history).map((call) => call.id)).toEqual([
    "call-1",
    "call-2",
  ]);
  history.push({
    message: {
      content: [{ type: "tool_result", tool_use_id: "call-1", content: "" }],
    },
  });
  expect(unresolvedToolUses(history).map((call) => call.id)).toEqual([
    "call-2",
  ]);
});

it("retains an unresolved batch even when the SDK returns an error", async () => {
  const run = new RecoveryRun(undefined, input(), ["Bash"]);
  for (const id of ["first", "second"])
    await run.hook({ ...hookInput, tool_use_id: id }, id, {
      signal: new AbortController().signal,
    });
  run.observe("native", "profile", { is_error: true });
  expect(run.binding?.unsupportedPendingTools?.map((call) => call.id)).toEqual([
    "first",
    "second",
  ]);
  expect(() => run.assertSupported()).toThrow("multiple pending tool calls");
});

it.each([false, true])(
  "retains unresolved child identity after parent completion (parent deferral=%s)",
  (parentDeferred) => {
    const run = new RecoveryRun(undefined, input());
    run.observeChildTool(pending, "parent-agent");
    run.observeToolResult("parent-agent"); // Async launch/completion is not the child result.
    run.observeToolResult(pending.id, "wrong-parent");
    run.observe(
      "native",
      "profile",
      parentDeferred
        ? {
            stop_reason: "tool_deferred",
            deferred_tool_use: { ...pending, id: "parent-read" },
          }
        : {},
    );
    expect(run.binding?.unsupportedPendingTools).toEqual(
      expect.arrayContaining([{ ...pending, parentToolUseId: "parent-agent" }]),
    );
    expect(() => run.assertSupported()).toThrow(
      "child deferral recovery is unsupported",
    );
    expect(
      () =>
        new RecoveryRun(
          JSON.parse(JSON.stringify(run.binding)),
          input("allow"),
        ),
    ).toThrow("child deferral recovery is unsupported");
  },
);

it("allows parent completion only after a correlated child result", () => {
  const run = new RecoveryRun(undefined, input());
  run.observeChildTool(pending, "parent-agent");
  run.observeToolResult(pending.id, "parent-agent");
  run.observe("native", "profile", {});
  expect(() => run.assertSupported()).not.toThrow();
  expect(run.binding?.unsupportedPendingTools).toBeUndefined();
});

it("never promotes an unresolved child deferral into a parent approval", async () => {
  const run = new RecoveryRun(undefined, input(), ["Bash"]);
  run.observeChildTool(pending, "parent-agent");
  run.observe("native", "profile", {
    stop_reason: "tool_deferred",
    deferred_tool_use: pending,
  });
  expect(run.binding?.pending).toBeUndefined();
  expect(run.binding?.unsupportedPendingTools).toEqual([
    { ...pending, parentToolUseId: "parent-agent" },
  ]);
  expect(() => run.assertSupported()).toThrow(
    "child deferral recovery is unsupported",
  );
});

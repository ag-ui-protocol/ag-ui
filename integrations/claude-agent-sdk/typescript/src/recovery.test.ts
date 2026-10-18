import { describe, it, expect } from "vitest";
import { RecoveryRun } from "./recovery";
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

// CAO's interrupt contract, as read from awslabs/cli-agent-orchestrator at the
// commit the integration README pins (367f53f3). The files cited below are
// identical at the earlier pin 4ad577ca, so the line numbers hold for both:
//
// - Every interrupt the /agui/v1/run run plane reports is built from one place,
//   `AgUiInterrupt(...)` (services/agui/run_plane.py:403-418), from the single
//   interrupt type `Interrupt(...)` (services/agui/handoff_approval.py:482).
// - Its `reason` is `<namespace>:<local>`, from `classify_reason`
//   (handoff_approval.py:72-97): the namespace is kiro, claude-code, codex or
//   a kebab-cased provider name; the local part is one of permission_request,
//   trust_prompt, approval_request or unknown_prompt (:100-132).
// - Every interrupt's `responseSchema` is `{ approved: boolean }` (required),
//   plus an optional `editedArgs` string only when "edit" is among its options
//   (run_plane.py:159-177). Options come from handoff_approval.py:340-370 and
//   are always a subset of approve / deny / edit.
// - A resume entry is read by `_map_resume_payload` (run_plane.py:95-127):
//   `{ approved: true }` approves, `{ approved: false }` denies, anything else
//   without `approved` or `editedArgs` is an error (run_plane.py:306-320).
//   An entry with status "cancelled" denies (run_plane.py:307-308).
//
// So every CAO interrupt takes `{ approved }`; none asks a question that needs
// a different payload. The fixtures below have the shape run_plane.py:386-413
// puts on the wire (camelCase metadata, empty message).
import assert from "node:assert/strict";
import test from "node:test";

import {
  ApprovalSession,
  collectApprovals,
  type ResumeHost,
} from "./tool-approval";

const schema = (edit: boolean) => ({
  type: "object",
  properties: {
    approved: { type: "boolean", description: "true=approve, false=deny" },
    ...(edit ? { editedArgs: { type: "string" } } : {}),
  },
  required: ["approved"],
});

function caoInterrupt(
  id: string,
  provider: string,
  terminalId: string,
  reason: string,
  options: string[],
) {
  return {
    id,
    reason,
    message: "",
    metadata: { provider, terminalId, sessionName: "cao-demo", options },
    responseSchema: schema(options.includes("edit")),
  };
}

// One fixture per reason CAO can produce for the supported providers.
const FIXTURES = [
  caoInterrupt("i1", "claude_code", "t1", "claude-code:permission_request", [
    "approve",
    "deny",
  ]),
  caoInterrupt("i2", "claude_code", "t2", "claude-code:trust_prompt", [
    "approve",
    "deny",
  ]),
  caoInterrupt("i3", "kiro_cli", "t3", "kiro:permission_request", [
    "approve",
    "deny",
    "edit",
  ]),
  caoInterrupt("i4", "kiro_cli", "t4", "kiro:trust_prompt", [
    "approve",
    "deny",
  ]),
  caoInterrupt("i5", "codex", "t5", "codex:trust_prompt", ["approve", "deny"]),
  caoInterrupt("i6", "codex", "t6", "codex:approval_request", [
    "approve",
    "deny",
    "edit",
  ]),
  caoInterrupt("i7", "claude_code", "t7", "claude-code:unknown_prompt", [
    "approve",
    "deny",
  ]),
];

// Checks a payload against a responseSchema the way CAO's resume reads it.
function satisfies(
  payload: unknown,
  responseSchema: ReturnType<typeof schema>,
): boolean {
  if (!payload || typeof payload !== "object") return false;
  const body = payload as Record<string, unknown>;
  const allowed = Object.keys(responseSchema.properties);
  return (
    responseSchema.required.every((key) => typeof body[key] === "boolean") &&
    Object.keys(body).every((key) => allowed.includes(key))
  );
}

test("every CAO interrupt reason is recognised as an approval, with its terminal", () => {
  for (const interrupt of FIXTURES) {
    const [approval] = collectApprovals(undefined, [interrupt]);
    assert.equal(approval.generic, undefined, interrupt.reason);
    assert.equal(approval.id, interrupt.id);
    assert.equal(
      approval.request.cao?.terminalId,
      interrupt.metadata.terminalId,
    );
  }
});

test("resume entries built for CAO-shaped interrupts satisfy each responseSchema", async () => {
  const sent: { interruptId: string; status: string; payload: unknown }[][] =
    [];
  const host: ResumeHost = {
    subscribe: () => ({ unsubscribe() {} }),
    async runAgent({ resume }) {
      sent.push(resume as (typeof sent)[number]);
    },
  };
  const session = new ApprovalSession(host, { agentId: "tool_approval" });
  // Answer the whole batch: approve the even ones, reject the odd ones.
  let outcome: Awaited<ReturnType<typeof session.answer>> = "waiting";
  for (const [index, interrupt] of FIXTURES.entries())
    outcome = await session.answer(FIXTURES, interrupt.id, index % 2 === 0);
  assert.deepEqual(outcome, { ok: true });
  assert.equal(sent.length, 1);
  assert.deepEqual(
    sent[0].map((entry) => entry.interruptId),
    FIXTURES.map((interrupt) => interrupt.id),
  );
  for (const entry of sent[0]) {
    const interrupt = FIXTURES.find((i) => i.id === entry.interruptId);
    assert.ok(interrupt);
    assert.equal(entry.status, "resolved");
    assert.ok(
      satisfies(entry.payload, interrupt.responseSchema),
      `${interrupt.reason}: ${JSON.stringify(entry.payload)} does not satisfy its responseSchema`,
    );
  }
});

test("approved is the only required field; editedArgs is optional and only valid with the edit option", () => {
  for (const interrupt of FIXTURES)
    assert.deepEqual(interrupt.responseSchema.required, ["approved"]);
  assert.equal(
    satisfies({ approved: true, editedArgs: "x" }, schema(false)),
    false,
  );
  assert.equal(satisfies({ approved: true }, schema(true)), true);
  assert.equal(satisfies({ editedArgs: "x" }, schema(true)), false);
});

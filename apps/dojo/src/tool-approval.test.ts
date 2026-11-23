import assert from "node:assert/strict";
import test from "node:test";

import {
  acceptsApproved,
  ApprovalSession,
  batchAtClick,
  collectApprovals,
  readSkippedResume,
  settleAnswer,
  sendResume,
  type ResumeAgent,
  type ResumeHost,
} from "./tool-approval";

const cao = (id: string, terminalId: string) => ({
  id,
  reason: "claude-code:permission_request",
  metadata: { provider: "claude-code", terminalId },
});

test("a single CAO interrupt yields one approval, keyed by its id", () => {
  const only = cao("int-1", "t1");
  const approvals = collectApprovals(only, [only]);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].id, "int-1");
  assert.equal(approvals[0].request.cao?.terminalId, "t1");
});

test("every pending CAO interrupt gets its own approval and id", () => {
  const first = cao("int-1", "t1");
  const second = cao("int-2", "t2");
  const approvals = collectApprovals(first, [first, second]);
  assert.deepEqual(
    approvals.map((a) => [a.id, a.request.cao?.terminalId]),
    [
      ["int-1", "t1"],
      ["int-2", "t2"],
    ],
  );
});

test("an interrupt that is not an approval still gets a generic entry", () => {
  const first = cao("int-1", "t1");
  const other = { id: "int-9", reason: "needs_input", metadata: {} };
  const approvals = collectApprovals(first, [first, other]);
  assert.deepEqual(
    approvals.map((a) => [a.id, a.generic === true]),
    [
      ["int-1", false],
      ["int-9", true],
    ],
  );
  assert.equal(approvals[1].request.toolName, "needs_input");
  assert.equal(
    collectApprovals(undefined, [{ id: "x" }])[0].request.toolName,
    "interrupt",
  );
});

test("a Mastra interrupt keeps its expense details", () => {
  const mastra = {
    id: "m-1",
    metadata: {
      mastra: {
        type: "mastra_tool_approval",
        toolName: "record_expense",
        args: { amount: 250, description: "team dinner" },
      },
    },
  };
  const [approval] = collectApprovals(mastra, [mastra]);
  assert.equal(approval.request.toolName, "record_expense");
  assert.equal(approval.request.args?.amount, 250);
});

test("without standard interrupts the legacy event value is used, with no id", () => {
  const approvals = collectApprovals(cao("int-1", "t1"), []);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].id, undefined);
  assert.deepEqual(collectApprovals({ nothing: true }, []), []);
});

// A stand-in for CopilotKitCore. Like the real runAgent (core index.mjs
// ~4505-4515), a failing run is reported to subscribers' onError with code
// agent_run_failed and the promise still RESOLVES.
type Subscriber = Parameters<ResumeHost["subscribe"]>[0];
// A stand-in for the agent: it reports RUN_FINISHED to subscribers, carrying
// the next queued `result`, as the CAO run plane does on a finished run.
type FakeAgent = ResumeAgent & { emit(runId?: string): Promise<void> };
function makeAgent(results: unknown[] = []): FakeAgent {
  const listeners = new Set<Parameters<ResumeAgent["subscribe"]>[0]>();
  return {
    agentId: "tool_approval",
    subscribe(subscriber) {
      listeners.add(subscriber);
      return { unsubscribe: () => void listeners.delete(subscriber) };
    },
    async emit(runId?: string) {
      const result = results.shift();
      for (const l of [...listeners])
        await l.onRunFinishedEvent?.({
          event: { result, runId },
          outcome: "success",
        });
    },
  };
}

// "ok" finishes the run; "run-error" reports an error; "abort" resolves with
// no RUN_FINISHED and no error (the Stop path); "reject" throws.
function fakeHost(script: Array<"ok" | "run-error" | "reject" | "abort">) {
  const subscribers = new Set<Subscriber>();
  const resumes: unknown[] = [];
  const host: ResumeHost = {
    subscribe(subscriber) {
      subscribers.add(subscriber);
      return { unsubscribe: () => void subscribers.delete(subscriber) };
    },
    async runAgent({ agent, resume, runId }) {
      resumes.push(resume);
      const step = script.shift() ?? "ok";
      if (step === "reject") throw new Error("detach failed");
      if (step === "run-error")
        for (const subscriber of [...subscribers])
          await subscriber.onError?.({
            error: new Error("fetch failed"),
            code: "agent_run_failed",
            context: { agentId: agent.agentId },
          });
      if (step === "ok") await (agent as FakeAgent).emit(runId);
      return { result: undefined, newMessages: [] };
    },
  };
  return { host, resumes, subscribers };
}
const agent = makeAgent();
const one = [{ id: "int-1" }];

test("a run that reports an error but resolves is NOT delivered", async () => {
  const { host } = fakeHost(["run-error"]);
  const session = new ApprovalSession(host, agent);
  const outcome = await session.answer(one, "int-1", true);
  assert.deepEqual(outcome, { ok: false, message: "fetch failed" });
});

test("a run that finishes without an error is delivered", async () => {
  const { host } = fakeHost(["ok"]);
  const outcome = await new ApprovalSession(host, agent).answer(
    one,
    "int-1",
    false,
  );
  assert.deepEqual(outcome, { ok: true });
});

test("a runAgent that rejects is reported too", async () => {
  const { host } = fakeHost(["reject"]);
  const outcome = await sendResume(host, agent, one, {
    "int-1": { status: "resolved", payload: { approved: true } },
  });
  assert.deepEqual(outcome, { ok: false, message: "detach failed" });
});

test("an earlier failure does not affect a later attempt, and the listener is removed", async () => {
  const { host, subscribers } = fakeHost(["run-error", "ok"]);
  const session = new ApprovalSession(host, agent);
  assert.deepEqual(await session.answer(one, "int-1", true), {
    ok: false,
    message: "fetch failed",
  });
  assert.equal(subscribers.size, 0);
  assert.deepEqual(await session.answer(one, "int-1", true), { ok: true });
  assert.equal(subscribers.size, 0);
});

test("an error for another agent does not fail this attempt", async () => {
  const subscribers = new Set<Subscriber>();
  const host: ResumeHost = {
    subscribe(subscriber) {
      subscribers.add(subscriber);
      return { unsubscribe: () => void subscribers.delete(subscriber) };
    },
    async runAgent({ runId }) {
      for (const subscriber of subscribers)
        await subscriber.onError?.({
          error: new Error("other agent"),
          code: "agent_run_failed",
          context: { agentId: "someone_else" },
        });
      await agent.emit(runId);
    },
  };
  assert.deepEqual(
    await sendResume(host, agent, one, {
      "int-1": { status: "resolved", payload: { approved: true } },
    }),
    { ok: true },
  );
});

test("failed decision, then retry: the same interrupt id is resumed", async () => {
  const { host, resumes } = fakeHost(["run-error", "ok"]);
  const session = new ApprovalSession(host, agent);
  const failed = await session.answer(one, "int-1", true);
  assert.deepEqual(failed, { ok: false, message: "fetch failed" });
  const retried = await session.answer(one, "int-1", true);
  assert.deepEqual(retried, { ok: true });
  const expected = [
    { interruptId: "int-1", status: "resolved", payload: { approved: true } },
  ];
  assert.deepEqual(resumes, [expected, expected]);
});

test("with two open interrupts nothing is sent until both are answered, and a retry resumes both", async () => {
  const { host, resumes } = fakeHost(["run-error", "ok"]);
  const session = new ApprovalSession(host, agent);
  const two = [{ id: "a" }, { id: "b" }];
  assert.equal(await session.answer(two, "a", true), "waiting");
  assert.equal(resumes.length, 0);
  const failed = await session.answer(two, "b", false);
  assert.deepEqual(failed, { ok: false, message: "fetch failed" });
  assert.deepEqual(await session.answer(two, "b", false), { ok: true });
  assert.deepEqual(
    (resumes[1] as { interruptId: string }[]).map((r) => r.interruptId),
    ["a", "b"],
  );
});

test("mixed batch: answering only the approval waits; answering both resumes once with both ids", async () => {
  const { host, resumes } = fakeHost(["ok"]);
  const session = new ApprovalSession(host, agent);
  const mixed = [{ id: "int-1" }, { id: "int-9" }];
  assert.equal(await session.answer(mixed, "int-1", true), "waiting");
  assert.equal(resumes.length, 0);
  assert.deepEqual(await session.answer(mixed, "int-9", false), { ok: true });
  assert.equal(resumes.length, 1);
  assert.deepEqual(
    (resumes[0] as { interruptId: string; payload: unknown }[]).map((r) => [
      r.interruptId,
      r.payload,
    ]),
    [
      ["int-1", { approved: true }],
      ["int-9", { approved: false }],
    ],
  );
});

test("partial batch: after a failed send the sent answers are locked and the retry carries them unchanged", async () => {
  const { host, resumes } = fakeHost(["run-error", "ok"]);
  const session = new ApprovalSession(host, agent);
  const two = [{ id: "a" }, { id: "b" }];
  assert.equal(await session.answer(two, "a", true), "waiting");
  const failed = await session.answer(two, "b", true);
  assert.deepEqual(failed, { ok: false, message: "fetch failed" });
  assert.deepEqual(
    [...session.sentAnswers()],
    [
      ["a", true],
      ["b", true],
    ],
  );
  // Changing A is refused and nothing is sent.
  assert.equal(await session.answer(two, "a", false), "locked");
  assert.equal(resumes.length, 1);
  // Retrying with the same answer resends exactly A=true, B=true.
  assert.deepEqual(await session.answer(two, "a", true), { ok: true });
  const payloads = (r: unknown) =>
    (r as { interruptId: string; payload: unknown }[]).map((e) => [
      e.interruptId,
      e.payload,
    ]);
  assert.deepEqual(payloads(resumes[1]), payloads(resumes[0]));
  assert.deepEqual(payloads(resumes[1]), [
    ["a", { approved: true }],
    ["b", { approved: true }],
  ]);
  assert.equal(session.sentAnswers().size, 0);
});

test("retry follows CAO's current pending list: once it no longer holds A, the retry resumes only B", async () => {
  const { host, resumes } = fakeHost(["run-error", "ok"]);
  const session = new ApprovalSession(host, agent);
  const two = [{ id: "a" }, { id: "b" }];
  assert.equal(await session.answer(two, "a", true), "waiting");
  const failed = await session.answer(two, "b", true);
  assert.deepEqual(failed, { ok: false, message: "fetch failed" });
  // The run plane reported only B as still pending, so the agent's pending
  // list (the page's open list) is now [B]. That does not prove A was
  // delivered (CAO can also expire A without a keystroke); the retry only
  // follows CAO's current list and sends just B.
  assert.deepEqual(await session.answer([{ id: "b" }], "b", true), {
    ok: true,
  });
  const ids = (r: unknown) =>
    (r as { interruptId: string }[]).map((e) => e.interruptId);
  assert.deepEqual(ids(resumes[0]), ["a", "b"]);
  assert.deepEqual(ids(resumes[1]), ["b"]);
  assert.equal(session.sentAnswers().size, 0);
});

test("retry with no evidence A was delivered: A stays in the batch with its locked answer", async () => {
  const { host, resumes } = fakeHost(["run-error", "ok"]);
  const session = new ApprovalSession(host, agent);
  const two = [{ id: "a" }, { id: "b" }];
  assert.equal(await session.answer(two, "a", true), "waiting");
  assert.deepEqual(await session.answer(two, "b", false), {
    ok: false,
    message: "fetch failed",
  });
  // The agent still lists both as pending, and the client refuses a run that
  // leaves one out, so both are resent; CAO skips an id it no longer holds.
  assert.deepEqual(await session.answer(two, "b", false), { ok: true });
  assert.deepEqual(
    (resumes[1] as { interruptId: string; payload: unknown }[]).map((e) => [
      e.interruptId,
      e.payload,
    ]),
    [
      ["a", { approved: true }],
      ["b", { approved: false }],
    ],
  );
});

test("an interrupt never sent in a batch stays changeable", async () => {
  const { host } = fakeHost(["ok"]);
  const session = new ApprovalSession(host, agent);
  const two = [{ id: "a" }, { id: "b" }];
  assert.equal(await session.answer(two, "a", true), "waiting");
  assert.equal(await session.answer(two, "a", false), "waiting");
  assert.equal(session.sentAnswers().size, 0);
});

const APPROVED = {
  type: "object",
  properties: { approved: { type: "boolean" } },
  required: ["approved"],
};
const MEETING = {
  type: "object",
  properties: { choice: { type: "string" } },
  required: ["choice"],
};

test("acceptsApproved only for an object schema with a boolean approved and nothing else required", () => {
  assert.equal(acceptsApproved(APPROVED), true);
  assert.equal(
    acceptsApproved({
      ...APPROVED,
      properties: { ...APPROVED.properties, editedArgs: { type: "string" } },
    }),
    true,
  );
  assert.equal(acceptsApproved(MEETING), false);
  assert.equal(
    acceptsApproved({ ...APPROVED, required: ["approved", "choice"] }),
    false,
  );
  assert.equal(
    acceptsApproved({
      type: "object",
      properties: { approved: { type: "string" } },
    }),
    false,
  );
  assert.equal(acceptsApproved(undefined), false);
  assert.equal(acceptsApproved("approved"), false);
});

test("who gets Approve/Reject: schema accepts approved, or a recognised approval with no schema", () => {
  const cao1 = { ...cao("c1", "t1"), responseSchema: APPROVED };
  const noSchemaGeneric = { id: "g1", reason: "needs_input", metadata: {} };
  const schemaGeneric = {
    id: "g2",
    reason: "ask",
    metadata: {},
    responseSchema: APPROVED,
  };
  const resumeSchema = {
    id: "g3",
    reason: "mastra:tool_suspend",
    metadata: {},
    responseSchema: MEETING,
  };
  const mastraNoSchema = {
    id: "m1",
    metadata: {
      mastra: {
        type: "mastra_tool_approval",
        toolName: "record_expense",
        args: {},
      },
    },
  };
  const mastraBadSchema = {
    ...mastraNoSchema,
    id: "m2",
    responseSchema: MEETING,
  };
  const out = collectApprovals(undefined, [
    cao1,
    noSchemaGeneric,
    schemaGeneric,
    resumeSchema,
    mastraNoSchema,
    mastraBadSchema,
  ]);
  assert.deepEqual(
    out.map((a) => [a.id, a.unsupported === true]),
    [
      ["c1", false],
      ["g1", true],
      ["g2", false],
      ["g3", true],
      ["m1", false],
      ["m2", true],
    ],
  );
  assert.match(out[3].schema ?? "", /"choice"/);
  assert.equal(out[1].schema, undefined);
});

test("a batch with an approval and a request needing another field builds no payload", async () => {
  const { host, resumes } = fakeHost(["ok"]);
  const session = new ApprovalSession(host, agent);
  const batch = [
    { id: "c1", answerable: true },
    { id: "g3", answerable: false },
  ];
  assert.equal(await session.answer(batch, "c1", true), "blocked");
  assert.equal(await session.answer(batch, "c1", false), "blocked");
  assert.equal(resumes.length, 0);
  assert.equal(session.sentAnswers().size, 0);
});

const agentFinishing = makeAgent;
const hostFor = (a: FakeAgent) => ({ ...fakeHost([]), agent: a });

test("readSkippedResume reads CAO's result shape and ignores anything else", () => {
  assert.deepEqual(
    readSkippedResume({
      skippedResume: [{ interruptId: "a", reason: "expired" }, { nope: 1 }],
    }),
    [{ interruptId: "a", reason: "expired" }],
  );
  assert.deepEqual(readSkippedResume(undefined), []);
  assert.deepEqual(readSkippedResume({ skippedResume: "x" }), []);
});

test("skippedResume expired: card removed, message shown, never retried", async () => {
  const a = agentFinishing([
    { skippedResume: [{ interruptId: "int-1", reason: "expired" }] },
  ]);
  const { host, resumes } = hostFor(a);
  const session = new ApprovalSession(host, a);
  const out = await session.answer(one, "int-1", true);
  assert.ok(typeof out === "object" && out.ok);
  assert.match(
    (out as { notices: { message: string }[] }).notices[0].message,
    /Not delivered: this request expired before your answer reached the agent/,
  );
  assert.ok(session.skippedIds().has("int-1"));
  // Answering it again sends nothing.
  assert.equal(await session.answer(one, "int-1", true), "waiting");
  assert.equal(resumes.length, 1);
});

test("skippedResume unknown after a locked send: may already have been applied, no retry", async () => {
  const a = agentFinishing([
    { skippedResume: [{ interruptId: "int-1", reason: "unknown" }] },
  ]);
  const { host, resumes } = fakeHost(["run-error", "ok"]);
  const session = new ApprovalSession(host, a);
  const failed = await session.answer(one, "int-1", true);
  assert.deepEqual(failed, { ok: false, message: "fetch failed" });
  const out = await session.answer(one, "int-1", true);
  assert.ok(typeof out === "object" && out.ok);
  assert.match(
    (out as { notices: { message: string }[] }).notices[0].message,
    /may already have been applied/,
  );
  assert.equal(await session.answer(one, "int-1", true), "waiting");
  assert.equal(resumes.length, 2);
});

test("skippedResume expired after a locked send: may already have been applied, no retry", async () => {
  const a = agentFinishing([
    { skippedResume: [{ interruptId: "int-1", reason: "expired" }] },
  ]);
  const { host, resumes } = fakeHost(["run-error", "ok"]);
  const session = new ApprovalSession(host, a);
  const failed = await session.answer(one, "int-1", true);
  assert.deepEqual(failed, { ok: false, message: "fetch failed" });
  const out = await session.answer(one, "int-1", true);
  assert.ok(typeof out === "object" && out.ok);
  const message = (out as { notices: { message: string }[] }).notices[0]
    .message;
  assert.match(message, /Not confirmed: this request expired/);
  assert.match(message, /may already have been applied/);
  assert.doesNotMatch(message, /Not delivered/);
  assert.equal(await session.answer(one, "int-1", true), "waiting");
  assert.equal(resumes.length, 2);
});

test("skippedResume unknown on the first send gets its own message, not expiry", async () => {
  const a = agentFinishing([
    { skippedResume: [{ interruptId: "int-1", reason: "unknown" }] },
  ]);
  const { host } = hostFor(a);
  const out = await new ApprovalSession(host, a).answer(one, "int-1", false);
  const message = (out as { notices: { message: string }[] }).notices[0]
    .message;
  assert.match(
    message,
    /Not delivered: the server no longer knows this request/,
  );
  assert.doesNotMatch(message, /expired/);
});

test("no skippedResume: quiet success as before; an id not listed is unchanged", async () => {
  const a = agentFinishing([
    { skippedResume: [{ interruptId: "b", reason: "expired" }] },
  ]);
  const { host } = hostFor(a);
  const session = new ApprovalSession(host, a);
  const two = [{ id: "a" }, { id: "b" }];
  await session.answer(two, "a", true);
  const out = await session.answer(two, "b", true);
  const notices = (out as { notices: { id: string }[] }).notices;
  assert.deepEqual(
    notices.map((n) => n.id),
    ["b"],
  );
  assert.ok(!session.skippedIds().has("a"));
  const plain = agentFinishing([undefined]);
  const h = hostFor(plain);
  assert.deepEqual(
    await new ApprovalSession(h.host, plain).answer(one, "int-1", true),
    {
      ok: true,
    },
  );
});

test("a run that resolves with no RUN_FINISHED and no error is NOT delivered (Stop)", async () => {
  const { host, resumes } = fakeHost(["abort", "ok"]);
  const session = new ApprovalSession(host, makeAgent());
  const out = await session.answer(one, "int-1", true);
  assert.deepEqual(out, {
    ok: false,
    message:
      "the run ended before it finished, so delivery is unconfirmed (was it stopped?)",
  });
  // The answer stays locked and the retry resends the same interrupt.
  assert.deepEqual([...session.sentAnswers()], [["int-1", true]]);
  assert.equal(await session.answer(one, "int-1", false), "locked");
  assert.deepEqual(await session.answer(one, "int-1", true), { ok: true });
  assert.equal(resumes.length, 2);
});

test("a cancelled run is not delivery either", async () => {
  const { host } = fakeHost(["abort"]);
  const cancelled: ResumeAgent = {
    agentId: "tool_approval",
    subscribe(subscriber) {
      void subscriber.onRunFinishedEvent?.({ event: {}, outcome: "cancelled" });
      return { unsubscribe() {} };
    },
  };
  const out = await sendResume(host, cancelled, one, {
    "int-1": { status: "resolved", payload: { approved: true } },
  });
  assert.deepEqual(out, {
    ok: false,
    message:
      "the run ended before it finished, so delivery is unconfirmed (was it stopped?)",
  });
});

test("two interrupts, only B skipped: the notice names B, keyed by id", async () => {
  const a = makeAgent([
    { skippedResume: [{ interruptId: "b", reason: "expired" }] },
  ]);
  const { host } = fakeHost(["ok"]);
  const session = new ApprovalSession(host, a);
  const two = [{ id: "a" }, { id: "b" }];
  await session.answer(two, "a", true);
  const out = await session.answer(two, "b", true);
  const notices = (out as { notices: { id: string }[] }).notices;
  assert.deepEqual(
    notices.map((n) => n.id),
    ["b"],
  );
  assert.deepEqual([...session.skippedIds()], ["b"]);
});

test("acceptsApproved needs both true and false allowed", () => {
  const withApproved = (approved: unknown) => ({
    type: "object",
    properties: { approved },
    required: ["approved"],
  });
  assert.equal(acceptsApproved(withApproved({ type: "boolean" })), true);
  // An allowlist: even an enum holding both values is not a form it verifies.
  assert.equal(
    acceptsApproved(withApproved({ type: "boolean", enum: [true, false] })),
    false,
  );
  assert.equal(
    acceptsApproved(withApproved({ type: "boolean", const: true })),
    false,
  );
  assert.equal(
    acceptsApproved(withApproved({ type: "boolean", enum: [true] })),
    false,
  );
  assert.equal(
    acceptsApproved(withApproved({ type: "boolean", not: { const: false } })),
    false,
  );
  // The pinned CAO forms, with and without editedArgs.
  assert.equal(
    acceptsApproved({
      type: "object",
      properties: {
        approved: { type: "boolean", description: "true=approve, false=deny" },
        editedArgs: { type: "string", description: "edited answer text" },
      },
      required: ["approved"],
    }),
    true,
  );
  // Root-level constraints make the answer invalid for at least one button.
  const base = withApproved({ type: "boolean" });
  for (const extra of [
    { const: { approved: true } },
    { allOf: [{ properties: { approved: { const: true } } }] },
    { anyOf: [{ required: ["approved"] }] },
    { not: { properties: { approved: { const: false } } } },
    { if: {}, then: {} },
    { $ref: "#/$defs/x" },
    { minProperties: 2 },
  ])
    assert.equal(acceptsApproved({ ...base, ...extra }), false);
  assert.equal(acceptsApproved(withApproved({ $ref: "#/$defs/yes" })), false);
  // Another property is fine while it is not required.
  assert.equal(
    acceptsApproved({
      ...base,
      properties: { approved: { type: "boolean" }, note: { type: "string" } },
      additionalProperties: false,
    }),
    true,
  );
  assert.equal(
    acceptsApproved({
      ...base,
      properties: { approved: { type: "boolean" }, note: { type: "string" } },
      required: ["approved", "note"],
    }),
    false,
  );
  // A const-true schema is not answerable from a page offering Reject.
  const [entry] = collectApprovals(undefined, [
    { id: "x", responseSchema: withApproved({ type: "boolean", const: true }) },
  ]);
  assert.equal(entry.unsupported, true);
});

for (const odd of ["constructor", "__proto__"]) {
  test(`interrupt id "${odd}" is an ordinary id: one batch carries both answers`, async () => {
    const { host, resumes } = fakeHost(["ok"]);
    const session = new ApprovalSession(host, agent);
    const two = [{ id: "a" }, { id: odd }];
    assert.equal(await session.answer(two, "a", true), "waiting");
    assert.deepEqual(await session.answer(two, odd, false), { ok: true });
    assert.equal(resumes.length, 1);
    assert.deepEqual(
      (resumes[0] as { interruptId: string; payload: unknown }[]).map((r) => [
        r.interruptId,
        r.payload,
      ]),
      [
        ["a", { approved: true }],
        [odd, { approved: false }],
      ],
    );
  });
}

test("batchAtClick builds the batch from the pending list; a click for a resolved id sends nothing", () => {
  const pending = collectApprovals(undefined, [cao("a", "ta"), cao("b", "tb")]);
  assert.deepEqual(batchAtClick(pending, new Set(), "a"), [
    { id: "a", answerable: true },
    { id: "b", answerable: true },
  ]);
  // "a" was resolved since the last render: it is no longer pending.
  const later = collectApprovals(undefined, [cao("b", "tb")]);
  assert.equal(batchAtClick(later, new Set(), "a"), undefined);
  // A skipped id is not part of the batch, and cannot be clicked either.
  assert.deepEqual(batchAtClick(pending, new Set(["b"]), "a"), [
    { id: "a", answerable: true },
  ]);
  assert.equal(batchAtClick(pending, new Set(["a"]), "a"), undefined);
});

test("a RUN_FINISHED from another run during the attempt does not confirm delivery", async () => {
  const a = makeAgent();
  const host: ResumeHost = {
    subscribe: () => ({ unsubscribe() {} }),
    async runAgent({ runId }) {
      // Some other run on the same agent finishes while this one is pending;
      // this attempt's own run never does.
      await a.emit(`${runId}-other`);
    },
  };
  const out = await sendResume(host, a, one, {
    "int-1": { status: "resolved", payload: { approved: true } },
  });
  assert.deepEqual(out, {
    ok: false,
    message:
      "the run ended before it finished, so delivery is unconfirmed (was it stopped?)",
  });
});

test("the attempt passes a fresh runId to runAgent and accepts only that run", async () => {
  const seen: string[] = [];
  const a = makeAgent();
  const host: ResumeHost = {
    subscribe: () => ({ unsubscribe() {} }),
    async runAgent({ runId }) {
      seen.push(runId);
      await a.emit(runId);
    },
  };
  const answers = {
    "int-1": { status: "resolved" as const, payload: { approved: true } },
  };
  assert.deepEqual(await sendResume(host, a, one, answers), { ok: true });
  assert.deepEqual(await sendResume(host, a, one, answers), { ok: true });
  assert.equal(seen.length, 2);
  assert.notEqual(seen[0], seen[1]);
  assert.ok(seen.every((id) => id.length > 0));
});

test("settleAnswer releases the busy state and reports a failure when answer() throws", async () => {
  // crypto.randomUUID and host.subscribe run before sendResume's try block, so
  // a throw there rejects session.answer().
  const a = agentFinishing([{}]);
  const host: ResumeHost = {
    ...fakeHost([]).host,
    subscribe() {
      throw new Error("subscribe failed");
    },
  };
  const session = new ApprovalSession(host, a);
  await assert.rejects(session.answer(one, "int-1", true), /subscribe failed/);

  let released = 0;
  const out = await settleAnswer(
    () => session.answer(one, "int-1", true),
    () => void released++,
  );
  assert.equal(released, 1);
  assert.deepEqual(out, { ok: false, message: "subscribe failed" });
});

test("settleAnswer releases once and passes a normal outcome through", async () => {
  let released = 0;
  const out = await settleAnswer(
    async () => "waiting" as const,
    () => void released++,
  );
  assert.equal(out, "waiting");
  assert.equal(released, 1);
});

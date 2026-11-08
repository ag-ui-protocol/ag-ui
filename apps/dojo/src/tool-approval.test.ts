import assert from "node:assert/strict";
import test from "node:test";

import {
  acceptsApproved,
  ApprovalSession,
  collectApprovals,
  sendResume,
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
function fakeHost(script: Array<"ok" | "run-error" | "reject">) {
  const subscribers = new Set<Subscriber>();
  const resumes: unknown[] = [];
  const host: ResumeHost = {
    subscribe(subscriber) {
      subscribers.add(subscriber);
      return { unsubscribe: () => void subscribers.delete(subscriber) };
    },
    async runAgent({ agent, resume }) {
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
      return { result: undefined, newMessages: [] };
    },
  };
  return { host, resumes, subscribers };
}
const agent = { agentId: "tool_approval" };
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
  assert.equal((await session.answer(one, "int-1", true)) !== "waiting", true);
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
    async runAgent() {
      for (const subscriber of subscribers)
        await subscriber.onError?.({
          error: new Error("other agent"),
          code: "agent_run_failed",
          context: { agentId: "someone_else" },
        });
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
  assert.equal(typeof failed === "object" && failed.ok, false);
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
  assert.equal(typeof failed === "object" && failed.ok, false);
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
  assert.equal(typeof failed === "object" && failed.ok, false);
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

import assert from "node:assert/strict";
import test from "node:test";
import {
  assertProtocolEvidence,
  findProtocolEvidenceProblems,
  findProtocolVersionViolations,
  type ProtocolEvidence,
  type ProtocolEvidenceAllowance,
  protocolVersionLaneOf,
} from "./event-trace-protocol-version";

function sse(...events: object[]) {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

test("maps Dojo CopilotKit SSE responses to their integration id", () => {
  assert.equal(
    protocolVersionLaneOf({
      method: "POST",
      url: "http://dojo.test/api/copilotkit/adk-js/agent/agentic_chat/run",
      contentType: "text/event-stream; charset=utf-8",
    }),
    "adk-js",
  );
  assert.equal(
    protocolVersionLaneOf({
      method: "POST",
      url: "http://dojo.test/api/copilotkitnext/ag2",
      contentType: "text/event-stream",
    }),
    "ag2",
  );
  assert.equal(
    protocolVersionLaneOf({
      method: "POST",
      url: "http://dojo.test/api/copilotkit/adk-js",
      contentType: "application/json",
    }),
    undefined,
  );
  assert.equal(
    protocolVersionLaneOf({
      method: "GET",
      url: "http://dojo.test/api/copilotkit/adk-js",
      contentType: "text/event-stream",
    }),
    undefined,
  );
  assert.equal(
    protocolVersionLaneOf({
      method: "POST",
      url: "http://dojo.test/api/copilotkit",
      contentType: "text/event-stream",
    }),
    undefined,
  );
});

test("accepts runs whose first RUN_STARTED declares 1.0", () => {
  const events = [
    { type: "RUN_STARTED", runId: "r1", threadId: "t", protocolVersion: "1.0" },
    { type: "RUN_FINISHED", runId: "r1", threadId: "t" },
    { type: "RUN_STARTED", runId: "r2", threadId: "t", protocolVersion: "1.0" },
  ];
  assert.deepEqual(findProtocolVersionViolations(events), []);
});

test("reports each run that omits or misdeclares the version", () => {
  const events = [
    { type: "RUN_STARTED", runId: "r1", threadId: "t" },
    { type: "RUN_FINISHED", runId: "r1", threadId: "t" },
    { type: "RUN_STARTED", runId: "r2", threadId: "t", protocolVersion: "0.9" },
    { type: "RUN_STARTED", runId: "r3", threadId: "t", protocolVersion: "1.0" },
  ];
  assert.deepEqual(findProtocolVersionViolations(events), [
    { runId: "r1", protocolVersion: undefined },
    { runId: "r2", protocolVersion: "0.9" },
  ]);
});

test("only the first RUN_STARTED of a run is judged", () => {
  const events = [
    { type: "RUN_STARTED", runId: "r1", threadId: "t", protocolVersion: "1.0" },
    { type: "RUN_STARTED", runId: "r1", threadId: "t" },
  ];
  assert.deepEqual(findProtocolVersionViolations(events), []);
});

const URL_ = "http://dojo.test/api/copilotkit/ag2";
const started = (runId: string, protocolVersion = "1.0") => ({
  type: "RUN_STARTED",
  runId,
  threadId: "t",
  protocolVersion,
});
const undeclared = (runId: string) => ({ type: "RUN_STARTED", runId, threadId: "t" });
const finished = (runId: string) => ({ type: "RUN_FINISHED", runId, threadId: "t" });
const stream = (...events: object[]) => ({ lane: "ag2", url: URL_, body: sse(...events) });
const evidence = (
  streams: ProtocolEvidence["streams"],
  { prompts = 1, allow = [] as ProtocolEvidenceAllowance[] } = {},
): ProtocolEvidence => ({ lanes: ["ag2"], streams, prompts, allowances: new Set(allow) });

test("a declared run per prompt passes", () => {
  assert.deepEqual(findProtocolEvidenceProblems(evidence([stream(started("r1"), finished("r1"))])), []);
  assert.deepEqual(
    findProtocolEvidenceProblems(
      evidence([stream(started("r1"), finished("r1")), stream(started("r2"), finished("r2"))], { prompts: 2 }),
    ),
    [],
  );
});

test("a missing or wrong declaration fails and names the lane", () => {
  assert.throws(
    () => assertProtocolEvidence(evidence([stream(undeclared("r1"))])),
    /\[ag2\] run r1 .*protocolVersion is undefined, expected "1.0"/,
  );
  assert.match(
    findProtocolEvidenceProblems(evidence([stream(started("r1", "0.9"))]))[0],
    /protocolVersion is "0.9"/,
  );
});

test("no run, an empty stream, or a stream without RUN_STARTED is not evidence of a run", () => {
  assert.match(findProtocolEvidenceProblems(evidence([]))[0], /no AG-UI run was observed/);
  assert.match(findProtocolEvidenceProblems(evidence([stream()]))[0], /no AG-UI run was observed/);
  assert.match(
    findProtocolEvidenceProblems(evidence([stream({ type: "RUN_ERROR", message: "boom" })]))[0],
    /no AG-UI run was observed/,
  );
  // CopilotKit opens empty streams of its own; next to the prompt's run they are harmless.
  assert.deepEqual(findProtocolEvidenceProblems(evidence([stream(), stream(started("r1"))])), []);
});

test("an unreadable body fails, even next to a valid run", () => {
  const problems = findProtocolEvidenceProblems(
    evidence([stream(started("r1")), { lane: "ag2", url: URL_, error: "Response body is unavailable" }]),
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /could not be read \(Response body is unavailable\)/);
});

test("a later prompt without its own run fails, even when an earlier run was valid", () => {
  assert.match(
    findProtocolEvidenceProblems(evidence([stream(started("r1"), finished("r1"))], { prompts: 2 }))[0],
    /2 prompt\(s\) were sent but only 1 run\(s\) started/,
  );
});

test("allowances cover only what they name", () => {
  // A render-only test opens the page and starts nothing.
  assert.deepEqual(findProtocolEvidenceProblems(evidence([], { prompts: 0, allow: ["no-run"] })), []);
  // An error test may end in RUN_ERROR before RUN_STARTED, but an empty stream is still not that error.
  assert.deepEqual(
    findProtocolEvidenceProblems(evidence([stream({ type: "RUN_ERROR", message: "boom" })], { allow: ["error"] })),
    [],
  );
  assert.match(
    findProtocolEvidenceProblems(evidence([stream()], { allow: ["error"] }))[0],
    /no AG-UI run was observed/,
  );
  // A run that did start must still declare its version, whatever is allowed.
  assert.match(
    findProtocolEvidenceProblems(evidence([stream(undeclared("r1"))], { allow: ["error", "cancel", "no-run"] }))[0],
    /protocolVersion is undefined/,
  );
  // A cancelled run's unreadable body is allowed only under "cancel".
  const cancelled = { lane: "ag2", url: URL_, error: "aborted" };
  assert.deepEqual(findProtocolEvidenceProblems(evidence([stream(started("r1")), cancelled], { allow: ["cancel"] })), []);
});

test("a test that never touched an enabled lane checks nothing", () => {
  assert.deepEqual(
    findProtocolEvidenceProblems({ lanes: [], streams: [], prompts: 3, allowances: new Set() }),
    [],
  );
});

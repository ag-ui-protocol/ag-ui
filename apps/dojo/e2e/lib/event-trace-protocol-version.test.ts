import assert from "node:assert/strict";
import test from "node:test";
import {
  assertProtocolEvidence,
  findProtocolEvidenceProblems,
  findProtocolVersionViolations,
  type ProtocolEvidence,
  type ProtocolEvidenceAllowance,
  promptKeyOfRequest,
  protocolVersionLaneOf,
  type ProtocolStream,
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
type StreamOptions = { prompt?: string; outcome?: ProtocolStream["outcome"]; error?: string };
// A stream answering the prompt with the given key ("p1" unless told otherwise).
const answer = (options: StreamOptions, ...events: object[]): ProtocolStream => ({
  lane: "ag2",
  url: URL_,
  promptKey: "prompt" in options ? options.prompt : "p1",
  body: sse(...events),
  outcome: options.outcome ?? "complete",
  error: options.error,
});
const stream = (...events: object[]) => answer({}, ...events);
const evidence = (
  streams: ProtocolEvidence["streams"],
  { prompts = 1, allow = [] as ProtocolEvidenceAllowance[] } = {},
): ProtocolEvidence => ({ lanes: ["ag2"], streams, prompts, allowances: new Set(allow) });

test("the prompt a request answers is its latest user message", () => {
  const body = (messages: object[]) => JSON.stringify({ threadId: "t", runId: "r", messages });
  assert.equal(
    promptKeyOfRequest(
      body([
        { id: "u1", role: "user", content: "hi" },
        { id: "a1", role: "assistant", content: "hello" },
        { id: "u2", role: "user", content: "weather?" },
        { id: "tool1", role: "tool", content: "{}", toolCallId: "c1" },
      ]),
    ),
    "id:u2",
  );
  // CopilotKit's single-route transport nests the run input in an envelope.
  assert.equal(
    promptKeyOfRequest(
      JSON.stringify({ method: "agent/run", params: { agentId: "a" }, body: { messages: [{ id: "u1", role: "user", content: "hi" }] } }),
    ),
    "id:u1",
  );
  assert.equal(promptKeyOfRequest(body([{ role: "user", content: "hi" }])), 'content:"hi"');
  assert.equal(promptKeyOfRequest(body([])), undefined);
  assert.equal(promptKeyOfRequest("not json"), undefined);
  assert.equal(promptKeyOfRequest(null), undefined);
});

test("a declared run per prompt passes", () => {
  assert.deepEqual(findProtocolEvidenceProblems(evidence([stream(started("r1"), finished("r1"))])), []);
  assert.deepEqual(
    findProtocolEvidenceProblems(
      evidence(
        [answer({ prompt: "p1" }, started("r1"), finished("r1")), answer({ prompt: "p2" }, started("r2"), finished("r2"))],
        { prompts: 2 },
      ),
    ),
    [],
  );
  // A prompt answered by several requests (a tool result sent back, say) is still one prompt.
  assert.deepEqual(
    findProtocolEvidenceProblems(evidence([stream(started("r1"), finished("r1")), stream(started("r2"), finished("r2"))])),
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
  assert.match(findProtocolEvidenceProblems(evidence([], { prompts: 0 }))[0], /no AG-UI run was observed/);
  assert.match(findProtocolEvidenceProblems(evidence([stream()]))[0], /no AG-UI run was observed/);
  assert.match(
    findProtocolEvidenceProblems(evidence([stream({ type: "RUN_ERROR", message: "boom" })]))[0],
    /no AG-UI run was observed/,
  );
  // CopilotKit opens empty streams of its own; next to the prompt's run they are harmless.
  assert.deepEqual(
    findProtocolEvidenceProblems(evidence([answer({ prompt: undefined }), stream(started("r1"))])),
    [],
  );
});

test("a stream that failed to read fails, even next to a valid run", () => {
  const problems = findProtocolEvidenceProblems(
    evidence([stream(started("r1")), answer({ outcome: "failed", error: "network error" })]),
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /reading the response failed \(network error\)/);
});

// Review on #3051, point 1: each prompt needs fresh evidence.
test("an earlier prompt's extra runs do not cover a later prompt that got an empty stream", () => {
  const problems = findProtocolEvidenceProblems(
    evidence(
      [
        answer({ prompt: "p1" }, started("r1"), finished("r1"), started("r2"), finished("r2")),
        answer({ prompt: "p2" }),
      ],
      { prompts: 2 },
    ),
  );
  assert.deepEqual(problems, [
    "[ag2] prompt 2 of 2 got no run of its own; each prompt needs a new run (an earlier prompt's runs, or a replay of one, do not count)",
  ]);
});

test("a replay of an earlier run in a later response does not answer the later prompt", () => {
  const problems = findProtocolEvidenceProblems(
    evidence(
      [answer({ prompt: "p1" }, started("r1"), finished("r1")), answer({ prompt: "p2" }, started("r1"), finished("r1"))],
      { prompts: 2 },
    ),
  );
  assert.match(problems[0], /prompt 2 of 2 got no run of its own/);
});

test("a prompt the chat shows but no request carried fails", () => {
  assert.match(
    findProtocolEvidenceProblems(evidence([stream(started("r1"), finished("r1"))], { prompts: 2 }))[0],
    /the chat shows 2 prompt\(s\) but only 1 run request\(s\) carried one/,
  );
});

// Review on #3051, point 2: cancellation must not hide version failures.
test("a cancelled stream's RUN_STARTED is still judged, and a stream the page did not cancel still fails", () => {
  const problems = findProtocolEvidenceProblems(
    evidence(
      [answer({ prompt: "p1" }, started("r1"), finished("r1")), answer({ prompt: "p2", outcome: "aborted" }, undeclared("r2"))],
      { prompts: 2, allow: ["cancel"] },
    ),
  );
  assert.deepEqual(problems, [
    '[ag2] run r2 at http://dojo.test/api/copilotkit/ag2: RUN_STARTED.protocolVersion is undefined, expected "1.0"',
  ]);
  // "cancel" covers only what the page aborted, never a stream that failed on its own.
  assert.match(
    findProtocolEvidenceProblems(
      evidence([stream(started("r1")), answer({ outcome: "failed", error: "boom" })], { allow: ["cancel"] }),
    )[0],
    /reading the response failed \(boom\)/,
  );
});

test("a stream cut off mid-event is judged on its complete events only", () => {
  const cut = { ...answer({ outcome: "aborted" }, started("r1")) };
  cut.body += 'data: {"type":"TEXT_MESSAGE_ST';
  assert.deepEqual(findProtocolEvidenceProblems(evidence([cut], { allow: ["cancel"] })), []);
  const undeclaredCut = { ...answer({ outcome: "aborted" }, undeclared("r1")) };
  undeclaredCut.body += "data: {";
  assert.match(
    findProtocolEvidenceProblems(evidence([undeclaredCut], { allow: ["cancel"] }))[0],
    /protocolVersion is undefined/,
  );
});

// Review on #3051, point 3: a cancellation-only test works.
test("a cancellation-only test passes when the cancelled run declared 1.0", () => {
  assert.deepEqual(
    findProtocolEvidenceProblems(evidence([answer({ outcome: "aborted" }, started("r1"))], { allow: ["cancel"] })),
    [],
  );
  // Cancelled before any event arrived: allowed under "cancel" only.
  assert.deepEqual(
    findProtocolEvidenceProblems(evidence([answer({ outcome: "aborted" })], { allow: ["cancel"] })),
    [],
  );
  assert.match(
    findProtocolEvidenceProblems(evidence([answer({ outcome: "aborted" })]))[0],
    /no AG-UI run was observed/,
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
});

test("a test that never touched an enabled lane checks nothing", () => {
  assert.deepEqual(
    findProtocolEvidenceProblems({ lanes: [], streams: [], prompts: 3, allowances: new Set() }),
    [],
  );
});

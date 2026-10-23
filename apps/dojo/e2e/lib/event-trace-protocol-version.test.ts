import assert from "node:assert/strict";
import test from "node:test";
import {
  assertStreamsDeclareProtocolVersion,
  findProtocolVersionViolations,
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

test("assertion parses SSE bodies and names the failing lane", () => {
  assert.doesNotThrow(() =>
    assertStreamsDeclareProtocolVersion([
      {
        lane: "adk-js",
        url: "http://dojo.test/api/copilotkit/adk-js",
        body: sse({
          type: "RUN_STARTED",
          runId: "r1",
          threadId: "t",
          protocolVersion: "1.0",
        }),
      },
    ]),
  );

  assert.throws(
    () =>
      assertStreamsDeclareProtocolVersion([
        {
          lane: "ag2",
          url: "http://dojo.test/api/copilotkit/ag2",
          body: sse({ type: "RUN_STARTED", runId: "r1", threadId: "t" }),
        },
      ]),
    /\[ag2\] run r1 .*protocolVersion is undefined, expected "1.0"/,
  );
});

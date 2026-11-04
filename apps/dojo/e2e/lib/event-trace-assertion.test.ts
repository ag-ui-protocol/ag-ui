import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { withEventTraceAssertion } from "./event-trace-assertion";
import { defineEventTrace } from "./event-trace-golden";
import type { TraceEvent } from "./event-trace-events";
import {
  createEventTraceUpdateCandidate,
  writeEventTraceUpdateCandidate,
} from "./event-trace-update";

const captured = [
  { type: "TOOL_CALL_ARGS", delta: '{"japanese":["勝利の道を"]}' },
];
const golden = defineEventTrace("file:///repo/chat.event-trace.ts", {
  chat: captured,
}).chat;

async function createCapture(
  t: TestContext,
  assertCaptured: (actual: readonly TraceEvent[]) => void | Promise<void>,
) {
  const stagingDirectory = await mkdtemp(
    join(tmpdir(), "event-trace-assertion-"),
  );
  t.after(() => rm(stagingDirectory, { recursive: true, force: true }));
  let writeStarted = false;
  const compare = withEventTraceAssertion(async (actual, expected) => {
    writeStarted = true;
    await writeEventTraceUpdateCandidate({
      stagingDirectory,
      testId: "unicode",
      candidate: createEventTraceUpdateCandidate({
        lane: "strands-python",
        actual,
        expected,
      }),
    });
  }, assertCaptured);
  return { compare, stagingDirectory, hasStartedWriting: () => writeStarted };
}

test("checks captured output before writing an update candidate", async (t) => {
  const error = new Error("captured Japanese text was corrupted");
  const { compare, stagingDirectory } = await createCapture(t, () => {
    throw error;
  });
  await assert.rejects(compare(captured, golden), (actual) => actual === error);
  assert.deepEqual(await readdir(stagingDirectory), []);
});

for (const outcome of ["resolve", "reject"] as const) {
  test(`waits for an asynchronous assertion to ${outcome} before deciding whether to write`, async (t) => {
    const deferred = Promise.withResolvers<void>();
    // Observe the rejected assertion even against the original, non-awaiting implementation.
    void deferred.promise.catch(() => {});
    const capture = await createCapture(t, () => deferred.promise);
    const pending = capture.compare(captured, golden);
    try {
      assert.equal(capture.hasStartedWriting(), false);
      assert.deepEqual(await readdir(capture.stagingDirectory), []);
      if (outcome === "resolve") {
        deferred.resolve();
        await pending;
        assert.equal(capture.hasStartedWriting(), true);
        assert.deepEqual(await readdir(capture.stagingDirectory), [
          "strands-python",
        ]);
      } else {
        const error = new Error("asynchronous semantic assertion failed");
        const rejection = assert.rejects(pending, (actual) => actual === error);
        deferred.reject(error);
        await rejection;
        assert.equal(capture.hasStartedWriting(), false);
        assert.deepEqual(await readdir(capture.stagingDirectory), []);
      }
    } finally {
      deferred.resolve();
      await pending.catch(() => {});
    }
  });
}

for (const assertCaptured of [
  undefined,
  (actual: readonly TraceEvent[]) => assert.equal(actual, captured),
]) {
  test(`passes actual and expected through after ${assertCaptured ? "successful" : "optional"} semantic assertion`, async () => {
    let called = false;
    await withEventTraceAssertion((actual, expected) => {
      assert.equal(actual, captured);
      assert.equal(expected, golden);
      called = true;
    }, assertCaptured)(captured, golden);
    assert.equal(called, true);
  });
}

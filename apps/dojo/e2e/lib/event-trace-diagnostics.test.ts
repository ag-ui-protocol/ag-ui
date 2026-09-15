import assert from "node:assert/strict";
import test from "node:test";
import { runEventTraceFixture } from "../event-trace-test";
import { EventTraceRecorder } from "./event-trace-recorder";

function fixture(attachmentError?: Error, removalError?: Error) {
  let attachments = 0;
  let removals = 0;
  const page = {
    on() {},
    off() {
      removals++;
      if (removalError) throw removalError;
    },
  };
  const info = {
    testId: "diagnostics",
    status: "passed" as "passed" | "failed",
    expectedStatus: "passed" as const,
    async attach() {
      attachments++;
      if (attachmentError) throw attachmentError;
    },
  };
  return {
    page,
    info,
    attachments: () => attachments,
    removals: () => removals,
  };
}

function hasErrors(...expected: unknown[]) {
  return (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors.length, expected.length);
    expected.forEach((value, index) =>
      assert.equal(error.errors[index], value),
    );
    return true;
  };
}

for (const phase of ["expectJourney", "finalize"] as const) {
  for (const attachmentFails of [false, true]) {
    test(`${phase} preserves original error when attachment ${attachmentFails ? "fails" : "succeeds"}`, async (t) => {
      const original = new Error(`${phase} failed`);
      const secondary = attachmentFails ? new Error("disk full") : undefined;
      t.mock.method(EventTraceRecorder.prototype, phase, async () => {
        throw original;
      });
      const f = fixture(secondary);
      await assert.rejects(
        runEventTraceFixture(
          f.page,
          async (trace) => {
            if (phase === "expectJourney") await trace.expectJourney([]);
          },
          f.info,
        ),
        secondary
          ? hasErrors(original, secondary)
          : (error) => error === original,
      );
      assert.equal(
        f.attachments(),
        attachmentFails ? 1 : phase === "expectJourney" ? 3 : 2,
      );
      assert.equal(f.removals(), 1);
    });
  }
}

test("failed assertion attachment is not retried during teardown", async (t) => {
  const original = new Error("assertion failed");
  const secondary = new Error("disk full");
  t.mock.method(EventTraceRecorder.prototype, "expectJourney", async () => {
    throw original;
  });
  const f = fixture(secondary);
  await runEventTraceFixture(
    f.page,
    async (trace) => {
      await assert.rejects(
        trace.expectJourney([]),
        hasErrors(original, secondary),
      );
      f.info.status = "failed";
    },
    f.info,
  );
  assert.equal(f.attachments(), 1);
  assert.equal(f.removals(), 1);
});

test("listener cleanup retains a pending failure and attachment failure", async () => {
  const original = new Error("test body failed");
  const attachment = new Error("disk full");
  const removal = new Error("listener removal failed");
  const f = fixture(attachment, removal);
  await assert.rejects(
    runEventTraceFixture(
      f.page,
      async () => {
        throw original;
      },
      f.info,
    ),
    hasErrors(original, attachment, removal),
  );
  assert.equal(f.attachments(), 1);
  assert.equal(f.removals(), 1);
});

test("real recorder capture failure survives a failing diagnostic attachment", async () => {
  const secondary = new Error("disk full");
  const f = fixture(secondary);
  await assert.rejects(
    runEventTraceFixture(
      f.page,
      async (trace) => {
        await trace.expectJourney([]);
      },
      f.info,
    ),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors.length, 2);
      assert.match(error.errors[0].message, /captured no non-RAW events/);
      assert.equal(error.errors[1], secondary);
      return true;
    },
  );
  assert.equal(f.attachments(), 1);
  assert.equal(f.removals(), 1);
});

test("teardown retains undefined as the original thrown value", async () => {
  const secondary = new Error("disk full");
  const f = fixture(secondary);
  await assert.rejects(
    runEventTraceFixture(
      f.page,
      async () => {
        throw undefined;
      },
      f.info,
    ),
    hasErrors(undefined, secondary),
  );
  assert.equal(f.removals(), 1);
});

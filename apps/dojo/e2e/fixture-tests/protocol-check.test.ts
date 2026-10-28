import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Runs protocol-check-scenarios.spec.ts in a real browser through the shared
// fixture and checks each scenario's verdict. The scenarios can't assert their
// own failure: the fixture's check runs after the test body, and Playwright's
// test.fail() would skip it.

const here = fileURLToPath(new URL(".", import.meta.url));
const e2eRoot = fileURLToPath(new URL("..", import.meta.url));

type Result = { title: string; status: string; error: string };

function runScenarios(): Result[] {
  // The report goes to a file: in CI, Playwright also prints to stdout.
  const reportFile = join(mkdtempSync(join(tmpdir(), "protocol-check-")), "report.json");
  const run = spawnSync(
    process.execPath,
    [
      "node_modules/@playwright/test/cli.js",
      "test",
      "-c",
      `${here}playwright.config.ts`,
      "--reporter=json",
    ],
    {
      cwd: e2eRoot,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: reportFile },
    },
  );
  if (!existsSync(reportFile)) {
    throw new Error(`Playwright wrote no report:\n${run.stdout}\n${run.stderr}`);
  }
  const report = JSON.parse(readFileSync(reportFile, "utf8")) as {
    suites: Array<{
      specs: Array<{
        title: string;
        tests: Array<{ results: Array<{ status: string; errors: Array<{ message?: string }> }> }>;
      }>;
    }>;
  };
  return report.suites.flatMap((suite) =>
    suite.specs.map((spec): Result => {
      const results = spec.tests[0]?.results ?? [];
      const result = results[results.length - 1];
      return {
        title: spec.title,
        status: result?.status ?? "missing",
        error: (result?.errors ?? []).map((e) => e.message ?? "").join("\n"),
      };
    }),
  );
}

test("the shared fixture judges each prompt and each cancellation on its own", () => {
  const results = new Map(runScenarios().map((r) => [r.title.split(":")[0], r]));
  const verdict = (name: string): Result => {
    const result = results.get(name);
    if (!result) throw new Error(`scenario ${name} did not run`);
    return result;
  };

  // Control: a run per prompt passes.
  assert.equal(verdict("fresh-runs").status, "passed", verdict("fresh-runs").error);

  // An earlier prompt's extra runs don't cover a later prompt's empty stream.
  assert.equal(verdict("extra-runs-then-empty").status, "failed");
  assert.match(verdict("extra-runs-then-empty").error, /prompt 2 of 2 got no run of its own/);

  // A replay of an earlier run doesn't answer a later prompt.
  assert.equal(verdict("replayed-run").status, "failed");
  assert.match(verdict("replayed-run").error, /prompt 2 of 2 got no run of its own/);

  // Cancelling doesn't hide a RUN_STARTED that arrived without a version.
  assert.equal(verdict("cancel-after-undeclared").status, "failed");
  assert.match(
    verdict("cancel-after-undeclared").error,
    /run r2 .*RUN_STARTED\.protocolVersion is undefined/,
  );

  // A cancellation-only test passes when its run declared 1.0.
  assert.equal(verdict("cancel-only").status, "passed", verdict("cancel-only").error);

  // An event cut off by the cancellation is not judged; the whole ones are.
  assert.equal(verdict("cancel-mid-event").status, "passed", verdict("cancel-mid-event").error);

  // A cancel through the page's reader reaches the response and counts as one.
  assert.equal(verdict("reader-cancel").status, "passed", verdict("reader-cancel").error);

  // Streams are judged in request order, whatever order the headers arrive in.
  assert.equal(verdict("overlapping-replay").status, "failed");
  assert.match(verdict("overlapping-replay").error, /prompt 2 of 2 got no run of its own/);
});

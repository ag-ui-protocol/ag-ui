import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { runEventTraceLane } from "./event-trace-runner";

const require = createRequire(import.meta.url);
// Exercise the installed Playwright CLI's file-filter semantics.
const playwrightRequire = createRequire(require.resolve("@playwright/test"));
const { createFileMatcherFromArguments } = playwrightRequire(
  path.join(
    path.dirname(playwrightRequire.resolve("playwright/package.json")),
    "lib/util.js",
  ),
) as {
  createFileMatcherFromArguments: (args: string[]) => (file: string) => boolean;
};
const laneOptions = {
  lane: { id: "strands-typescript", playwrightSuite: "aws-strands-typescript" },
  targets: ["tests/path with spaces/chat.spec.ts"],
  e2eRoot: "/repo with spaces/e2e",
  stagingDirectory: "/repo with spaces/e2e/.event-trace-update",
};

test("launches Playwright through Node without a platform-specific shell wrapper", () => {
  let calls = 0;
  runEventTraceLane(laneOptions, (command, args, options) => {
    calls += 1;
    assert.equal(command, process.execPath);
    assert.deepEqual(args, [
      require.resolve("@playwright/test/cli"),
      "test",
      "(?:^|[/\\\\])tests/path with spaces/chat\\.spec\\.ts$",
      "--retries=0",
      "--workers=1",
      "--timeout=120000",
    ]);
    assert.equal(options.shell, undefined);
    assert.equal(options.cwd, laneOptions.e2eRoot);
    assert.equal(options.stdio, "inherit");
    assert.deepEqual(options.env, {
      ...process.env,
      EVENT_TRACE_UPDATE_LANE: laneOptions.lane.id,
      EVENT_TRACE_UPDATE_STAGING_DIR: laneOptions.stagingDirectory,
      PLAYWRIGHT_SUITE: laneOptions.lane.playwrightSuite,
    });
    return { status: 0, signal: null };
  });
  assert.equal(calls, 1);
});

for (const platform of [path.posix, path.win32]) {
  test(`selects literal ${platform === path.win32 ? "Windows" : "POSIX"} target paths through Playwright's matcher`, () => {
    const target = platform.join(
      "tests",
      "suite [draft]+(v2)$^{}",
      "backend tool.spec.ts",
    );
    const root =
      platform === path.win32
        ? "C:\\repo with spaces\\e2e"
        : "/repo with spaces/e2e";
    runEventTraceLane(
      { ...laneOptions, targets: [target] },
      (_command, args) => {
        const matches = createFileMatcherFromArguments(args.slice(2, -3));
        assert.equal(matches(platform.join(root, target)), true);
        assert.equal(matches(platform.join(root, target + ".backup")), false);
        assert.equal(matches(platform.join(root, "prefix-" + target)), false);
        assert.equal(
          matches(
            platform.join(root, target.replace("tool.spec", "toolXspec")),
          ),
          false,
        );
        assert.equal(
          matches(
            platform.join(
              root,
              "tests",
              "suite draftv2",
              "backend tool.spec.ts",
            ),
          ),
          false,
        );
        return { status: 0, signal: null };
      },
    );
  });
}

test("preserves the original child startup error", () => {
  const error = new Error("spawn EACCES");
  assert.throws(
    () =>
      runEventTraceLane(laneOptions, () => ({
        status: null,
        signal: null,
        error,
      })),
    (actual) => actual === error,
  );
});

for (const result of [
  { status: 1, signal: null },
  { status: null, signal: "SIGTERM" },
] as const) {
  test(`rejects an unsuccessful child (status ${result.status}, signal ${result.signal})`, () => {
    assert.throws(() => runEventTraceLane(laneOptions, () => result), {
      message: `strands-typescript Event trace update lane failed (${result.signal ? `signal ${result.signal}` : `exit status ${result.status}`}); no golden files were written`,
    });
  });
}

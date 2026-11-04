import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runEventTraceLane } from "./event-trace-runner";

const require = createRequire(import.meta.url);
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
  test(`selects literal ${platform === path.win32 ? "Windows" : "POSIX"} target paths with the emitted regex`, () => {
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
        const patterns = args.slice(2, -3);
        assert.equal(patterns.length, 1);
        const pattern = new RegExp(patterns[0]);
        const matches = (file: string) => pattern.test(file);
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

test("selects only the literal target through the public Playwright CLI", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "event-trace-runner-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = path.join(
    "tests",
    "suite [draft]+(v2)$^{}",
    "backend tool.spec.ts",
  );
  const fixtures = [
    [target, "literal target"],
    [target + ".backup.spec.ts", "suffix mismatch"],
    ["prefix-" + target, "prefix mismatch"],
    [target.replace("tool.spec", "toolXspec"), "dot mismatch"],
    [
      path.join("tests", "suite draftv2", "backend tool.spec.ts"),
      "metacharacter mismatch",
    ],
  ];
  for (const [file, title] of fixtures) {
    const absolutePath = path.join(root, file);
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    writeFileSync(
      absolutePath,
      `const { test } = require(${JSON.stringify(require.resolve("@playwright/test"))});\ntest(${JSON.stringify(title)}, () => {});\n`,
    );
  }
  const config = path.join(root, "playwright.config.cjs");
  writeFileSync(
    config,
    'module.exports = { testDir: ".", testMatch: "**/*.ts" };\n',
  );
  const listOptions = ["--config", config, "--list", "--reporter=json"];
  const list = (command: string, args: string[]) => {
    const result = spawnSync(command, [...args, ...listOptions], {
      cwd: root,
      encoding: "utf8",
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout) as {
      errors: unknown[];
      suites: ReportSuite[];
    };
    assert.deepEqual(report.errors, []);
    type ReportSuite = {
      suites?: ReportSuite[];
      specs?: { title: string }[];
    };
    const titles = (suites: ReportSuite[]): string[] =>
      suites.flatMap((suite) => [
        ...(suite.specs ?? []).map((spec) => spec.title),
        ...titles(suite.suites ?? []),
      ]);
    return { result, titles: titles(report.suites) };
  };

  // Confirm every negative fixture is discoverable without the lane filter.
  const all = list(process.execPath, [
    require.resolve("@playwright/test/cli"),
    "test",
  ]);
  assert.deepEqual(
    all.titles.sort(),
    fixtures.map(([, title]) => title).sort(),
  );
  let calls = 0;
  runEventTraceLane(
    { ...laneOptions, e2eRoot: root, targets: [target] },
    (command, args) => {
      calls += 1;
      const selected = list(command, args);
      assert.deepEqual(selected.titles, ["literal target"]);
      return selected.result;
    },
  );
  assert.equal(calls, 1);
});

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

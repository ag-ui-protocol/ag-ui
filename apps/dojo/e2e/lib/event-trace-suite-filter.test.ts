import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("the matrix workflow selects only its requested Playwright suite through pnpm", (t) => {
  const e2eRoot = fileURLToPath(new URL("../", import.meta.url));
  const workflow = readFileSync(
    new URL("../../../../.github/workflows/dojo-e2e.yml", import.meta.url),
    "utf8",
  );
  const step = workflow.match(
    /^      - name: Run tests – \$\{\{ matrix\.suite \}\}\n([\s\S]*?)(?=^      - name:)/m,
  )?.[1];
  assert.ok(step, "the matrix Run tests step must exist");
  assert.match(step, /^          TEST_PATH: \$\{\{ matrix\.test_path \}\}$/m);
  const run = step.match(/        run: \|\n((?:          .*\n)+)/)?.[1];
  assert.ok(run, "the matrix Run tests shell invocation must exist");
  const invocation = run
    .split("\n")
    .map((line) => line.slice(10))
    .join("\n")
    .trim();
  assert.match(invocation, /^pnpm test\b/);

  const root = mkdtempSync(path.join(os.tmpdir(), "dojo-suite-filter-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const manifest = JSON.parse(
    readFileSync(path.join(e2eRoot, "package.json"), "utf8"),
  ) as { scripts: { test: string } };
  assert.equal(manifest.scripts.test, "playwright test");
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ private: true, scripts: { test: manifest.scripts.test } }),
  );
  symlinkSync(
    path.join(e2eRoot, "node_modules"),
    path.join(root, "node_modules"),
    "junction",
  );
  writeFileSync(
    path.join(root, "playwright.config.cjs"),
    'module.exports = { testDir: "./tests", testMatch: "**/*.spec.cjs" };\n',
  );
  const folders = ["tests/first suite", "tests/second suite"];
  for (const folder of folders) {
    mkdirSync(path.join(root, folder), { recursive: true });
    writeFileSync(
      path.join(root, folder, "fixture.spec.cjs"),
      `const { test } = require("@playwright/test");\ntest(${JSON.stringify(folder)}, () => {});\n`,
    );
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // Use already installed tooling, including when a Corepack shim is on PATH.
    COREPACK_ENABLE_NETWORK: "0",
    npm_config_manage_package_manager_versions: "false",
    npm_config_offline: "true",
  };
  for (const key of Object.keys(env)) {
    if (key.startsWith("PLAYWRIGHT_JSON_OUTPUT_")) delete env[key];
  }
  // pnpm supplies its installed entry point when running the unit-test script.
  // Other local runners can use the pnpm already available on PATH.
  const pnpmEntry = process.env.npm_execpath;
  const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const pnpm =
    pnpmEntry && /pnpm\.(?:c?js|mjs)$/.test(pnpmEntry)
      ? `${shellQuote(process.execPath)} ${shellQuote(pnpmEntry)}`
      : "pnpm";
  // Keep discovery flags before any workflow '--' so even that regression
  // only lists fixtures: it cannot start browsers or application servers.
  const command = invocation.replace(
    /^pnpm test\b/,
    `${pnpm} test --list --reporter=json`,
  );
  type Suite = { suites?: Suite[]; specs?: { title: string }[] };
  const titles = (suites: Suite[]): string[] =>
    suites.flatMap((suite) => [
      ...(suite.specs ?? []).map((spec) => spec.title),
      ...titles(suite.suites ?? []),
    ]);
  const list = (testPath: string) => {
    const result = spawnSync("bash", ["-eu", "-c", command], {
      cwd: root,
      env: { ...env, TEST_PATH: testPath },
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    // pnpm prints its script banner before the JSON reporter output.
    const report = JSON.parse(
      result.stdout.slice(result.stdout.indexOf("{")),
    ) as {
      errors: unknown[];
      suites: Suite[];
    };
    assert.deepEqual(report.errors, []);
    return titles(report.suites).sort();
  };
  assert.deepEqual(list(""), [...folders].sort(), "unfiltered discovery");
  for (const folder of folders) {
    assert.deepEqual(list(folder), [folder], `suite filter ${folder}`);
  }
});

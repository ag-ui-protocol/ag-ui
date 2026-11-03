// node --test .github/scripts/required-checks-areas.test.mjs
// Standalone node:test suite; no dependencies to install.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  AREAS,
  classify,
  included,
  parseChangedFiles,
  pullRequestPaths,
} from "./required-checks-areas.mjs";

// Items of the `push.paths` list in a workflow, comments skipped. No YAML
// parser is installed, so this reads the fixed shape these workflows use:
// `  push:` > `    paths:` > `      - "glob"`.
function pushPaths(file) {
  const lines = readFileSync(file, "utf8").split("\n");
  const start = lines.indexOf("  push:");
  assert.ok(start >= 0, `${file}: no push trigger`);
  const out = [];
  let inPaths = false;
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line) || /^  \S/.test(line)) break;
    if (line === "    paths:") {
      inPaths = true;
      continue;
    }
    if (/^    \S/.test(line)) inPaths = false;
    const item = inPaths && line.match(/^      - "?([^"#]+?)"?\s*$/);
    if (item) out.push(item[1]);
  }
  return out;
}

test("each area list is an exact copy of its workflow's push paths", () => {
  for (const [area, { workflow, paths }] of Object.entries(AREAS)) {
    assert.deepEqual(paths, pushPaths(workflow), area);
  }
});

test("called workflows have no pull_request trigger and accept workflow_call", () => {
  for (const { workflow } of Object.values(AREAS)) {
    const text = readFileSync(workflow, "utf8");
    assert.match(text, /^  workflow_call:/m, workflow);
    assert.doesNotMatch(text, /^  pull_request:/m, workflow);
  }
});

test("called workflows never key concurrency on github.workflow", () => {
  // Under workflow_call, github.workflow is the CALLER's name, so two called
  // workflows keyed on it share one group and cancel each other.
  for (const { workflow } of Object.values(AREAS)) {
    assert.doesNotMatch(
      readFileSync(workflow, "utf8"),
      /group:.*github\.workflow/,
      workflow,
    );
  }
});

test("required-checks.yml calls every area and actionlint covers them", () => {
  const caller = readFileSync(".github/workflows/required-checks.yml", "utf8");
  const lint = readFileSync(
    ".github/workflows/lint-release-workflows.yml",
    "utf8",
  );
  const files = [
    ".github/workflows/required-checks.yml",
    ...Object.values(AREAS).map((a) => a.workflow),
  ];
  for (const { workflow } of Object.values(AREAS)) {
    assert.ok(caller.includes(`uses: ./${workflow}`), workflow);
  }
  const flags = lint.split("actionlint_flags: >-")[1].split("\n\n")[0];
  for (const file of files) {
    assert.ok(flags.includes(file), `actionlint_flags misses ${file}`);
    // the two `paths:` blocks (push and pull_request)
    assert.equal(
      lint.split(`- "${file}"`).length - 1,
      2,
      `paths misses ${file}`,
    );
  }
});

test("ordered include, exclude and re-include", () => {
  const py = pullRequestPaths("unit_python");
  assert.equal(included("integrations/foo/python/uv.lock", py), true);
  assert.equal(included("integrations/foo/python/examples/uv.lock", py), false);
  assert.equal(
    included("integrations/crew-ai/python/examples/uv.lock", py),
    true,
  );
  assert.equal(included("uv.lock", py), true);
});

test("star stays inside one path segment; double star crosses them", () => {
  assert.equal(included("a/b.json", ["a/*.json"]), true);
  assert.equal(included("a/x/b.json", ["a/*.json"]), false);
  assert.equal(included("a/x/y/b.json", ["a/**"]), true);
  assert.equal(
    included("sdks/typescript/.eslintrc", ["sdks/typescript/**"]),
    true,
  );
});

test("unsupported glob syntax is rejected, not mis-read", () => {
  for (const glob of ["a/?.md", "a/[ab].md", "a/{b,c}.md"]) {
    assert.throws(() => included("a/b.md", [glob]), /unsupported glob/);
  }
});

test("docs-only change selects nothing; own files select everything", () => {
  assert.deepEqual(classify(["docs/introduction.mdx", "README.md"]), {
    lint: false,
    typecheck: false,
    unit_typescript: false,
    unit_python: false,
  });
  for (const self of [
    ".github/workflows/required-checks.yml",
    ".github/scripts/required-checks-areas.mjs",
  ]) {
    assert.ok(Object.values(classify([self])).every(Boolean), self);
  }
});

test("typical changes select the expected areas", () => {
  assert.deepEqual(classify(["apps/dojo/src/app/page.tsx"]), {
    lint: true,
    typecheck: false,
    unit_typescript: false,
    unit_python: false,
  });
  assert.deepEqual(classify(["sdks/python/ag_ui/core/events.py"]), {
    lint: false,
    typecheck: true,
    unit_typescript: true,
    unit_python: true,
  });
});

// Paths git quotes in its default output: non-ASCII, `"`, `\`, tab, newline.
const AWKWARD = [
  "sdks/python/ag_ui/café.py",
  'sdks/python/ag_ui/a"b.py',
  "sdks/python/ag_ui/a\\b.py",
  "sdks/python/ag_ui/a\tb.py",
  "sdks/python/ag_ui/a\nb.py",
];

test("patterns match paths that contain a newline", () => {
  assert.equal(included("sdks/python/a\nb.py", ["sdks/python/**"]), true);
  assert.equal(included("a\nb.json", ["*.json"]), true);
});

function runClassifier(input) {
  return spawnSync(
    process.execPath,
    [".github/scripts/required-checks-areas.mjs"],
    { input, encoding: "utf8" },
  );
}

test("classifier reads a NUL-terminated list verbatim", () => {
  for (const file of AWKWARD) {
    const run = runClassifier(`README.md\0${file}\0`);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /^unit_python=true$/m, JSON.stringify(file));
  }
  const empty = runClassifier("");
  assert.equal(empty.status, 0, empty.stderr);
  assert.match(empty.stdout, /^unit_python=false$/m);
});

test("parseChangedFiles splits on NUL and drops a trailing CR", () => {
  assert.deepEqual(parseChangedFiles(""), []);
  assert.deepEqual(parseChangedFiles("a\nb\0package.json\r\0"), [
    "a\nb",
    "package.json",
  ]);
  assert.throws(() => parseChangedFiles("a\0b"), /NUL-terminated/);
});

test("classifier rejects a newline-separated list", () => {
  const run = runClassifier("sdks/python/ag_ui/core/events.py\n");
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /NUL-terminated/);
});

// The body of required-checks.yml's "Classify changed files" step. No YAML
// parser is installed, so this reads the fixed `run: |` block shape.
function classifyStepScript() {
  const lines = readFileSync(
    ".github/workflows/required-checks.yml",
    "utf8",
  ).split("\n");
  const start = lines.indexOf("        id: areas");
  assert.ok(start >= 0, "no `id: areas` step");
  assert.equal(lines[start + 1], "        run: |");
  const body = [];
  for (const line of lines.slice(start + 2)) {
    if (line !== "" && !line.startsWith("          ")) break;
    body.push(line.slice(10));
  }
  return body.join("\n");
}

test("the workflow's classify step selects areas for awkward file names", () => {
  const script = classifyStepScript();
  for (const file of AWKWARD) {
    const repo = mkdtempSync(join(tmpdir(), "required-checks-"));
    try {
      const git = (...args) =>
        execFileSync(
          "git",
          [
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@example.com",
            "-c",
            "commit.gpgsign=false",
            ...args,
          ],
          { cwd: repo, stdio: "pipe" },
        );
      git("init", "-q", "-b", "main");
      writeFileSync(join(repo, "README.md"), "x\n");
      git("add", "-A");
      git("commit", "-q", "-m", "base");
      git("checkout", "-q", "-b", "pr");
      mkdirSync(join(repo, dirname(file)), { recursive: true });
      writeFileSync(join(repo, file), "x\n");
      git("add", "-A");
      git("commit", "-q", "-m", "pr");
      git("checkout", "-q", "main");
      // HEAD is a two-parent merge commit, like the PR merge ref.
      git("merge", "-q", "--no-ff", "-m", "merge", "pr");
      // Untracked, so it is not part of the diff.
      mkdirSync(join(repo, ".github/scripts"), { recursive: true });
      copyFileSync(
        ".github/scripts/required-checks-areas.mjs",
        join(repo, ".github/scripts/required-checks-areas.mjs"),
      );
      const runnerTemp = mkdtempSync(join(tmpdir(), "runner-temp-"));
      const output = join(runnerTemp, "output");
      const run = spawnSync("bash", ["-e", "-c", script], {
        cwd: repo,
        encoding: "utf8",
        env: { ...process.env, RUNNER_TEMP: runnerTemp, GITHUB_OUTPUT: output },
      });
      assert.equal(run.status, 0, run.stderr + run.stdout);
      assert.match(run.stdout, /^Changed files: 1$/m, JSON.stringify(file));
      assert.match(
        readFileSync(output, "utf8"),
        /^unit_python=true$/m,
        JSON.stringify(file),
      );
      rmSync(runnerTemp, { recursive: true, force: true });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }
});

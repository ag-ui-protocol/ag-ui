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
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  AREAS,
  MAX_FILES,
  classify,
  classifyRange,
  included,
  parseChangedFiles,
  pullRequestPaths,
  validate,
} from "./required-checks-areas.mjs";

const NONE = {
  lint: false,
  typecheck: false,
  unit_typescript: false,
  unit_python: false,
};
const ALL = {
  lint: true,
  typecheck: true,
  unit_typescript: true,
  unit_python: true,
};

function git(cwd, ...args) {
  return execFileSync(
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
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

function commitFiles(cwd, files, message) {
  for (const file of files) {
    mkdirSync(dirname(join(cwd, file)), { recursive: true });
    writeFileSync(join(cwd, file), `${file}\n`);
  }
  git(cwd, "add", "-A");
  git(cwd, "commit", "-qm", message);
}

// A repo with main, a PR branch adding prFiles, and the PR merge commit
// checked out on main, as actions/checkout leaves it for pull_request.
function prRepo(prFiles, mainFiles = []) {
  const dir = mkdtempSync(join(tmpdir(), "required-checks-"));
  git(dir, "init", "-q", "-b", "main");
  commitFiles(dir, ["README.md"], "root");
  git(dir, "checkout", "-qb", "pr");
  commitFiles(dir, prFiles, "pr");
  git(dir, "checkout", "-q", "main");
  if (mainFiles.length) commitFiles(dir, mainFiles, "main moved on");
  git(dir, "merge", "-q", "--no-ff", "-m", "merge", "pr");
  return dir;
}

// One `- item` value: a double-quoted, single-quoted or plain scalar, then an
// optional ` # comment`. Anything else throws, so a line this cannot read
// fails the test instead of silently dropping out of the comparison.
function pathItem(file, n, raw) {
  const fail = (why) => {
    throw new Error(`${file}:${n}: ${why}: ${JSON.stringify(raw)}`);
  };
  let value;
  let rest;
  if (raw.startsWith('"')) {
    const end = raw.indexOf('"', 1);
    if (end < 0) fail("unterminated double-quoted item");
    value = raw.slice(1, end);
    if (value.includes("\\")) fail("escape sequences are not supported");
    rest = raw.slice(end + 1);
  } else if (raw.startsWith("'")) {
    const m = raw.match(/^'((?:[^']|'')*)'(.*)$/);
    if (!m) fail("unterminated single-quoted item");
    value = m[1].replaceAll("''", "'");
    rest = m[2];
  } else {
    // a plain scalar ends at the first ` #`
    const hash = raw.search(/\s#/);
    value = (hash < 0 ? raw : raw.slice(0, hash)).trimEnd();
    rest = hash < 0 ? "" : raw.slice(hash);
    if (/^[!&*>|%@`{[\]]/.test(value) || /:(\s|$)/.test(value)) {
      fail("not a plain path scalar");
    }
  }
  if (!/^(\s+#.*)?\s*$/.test(rest)) fail("trailing text after item");
  if (value === "") fail("empty item");
  return value;
}

// Items of the `push.paths` list in a workflow. No YAML parser is installed,
// so this reads the fixed shape these workflows use:
// `  push:` > `    paths:` > `      - "glob"`. Blank and comment-only lines are
// skipped wherever they sit; every other line inside `paths:` must be an item.
function pushPaths(file) {
  const lines = readFileSync(file, "utf8").split("\n");
  const start = lines.indexOf("  push:");
  assert.ok(start >= 0, `${file}: no push trigger`);
  const out = [];
  let inPaths = false;
  let sawPaths = false;
  for (const [i, line] of lines.slice(start + 1).entries()) {
    const n = start + i + 2;
    if (/^\s*(#.*)?$/.test(line)) continue;
    if (/^\S/.test(line) || /^  \S/.test(line)) break;
    if (/^    paths:/.test(line)) {
      if (!/^    paths:\s*(#.*)?$/.test(line)) {
        throw new Error(`${file}:${n}: paths must be a block list: ${line}`);
      }
      inPaths = sawPaths = true;
      continue;
    }
    if (/^    \S/.test(line)) {
      inPaths = false;
      continue;
    }
    if (!inPaths) continue;
    const item = line.match(/^      - (\S.*)$/);
    if (!item) throw new Error(`${file}:${n}: unreadable paths line: ${line}`);
    out.push(pathItem(file, n, item[1]));
  }
  assert.ok(sawPaths && out.length > 0, `${file}: no push.paths items`);
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

// Runs the classifier CLI on the PR merge commit of a scratch repo, as the
// workflow does.
function runClassifier(
  repo,
  script = ".github/scripts/required-checks-areas.mjs",
) {
  return spawnSync(process.execPath, [resolve(script), "HEAD^1", "HEAD^2"], {
    cwd: repo,
    encoding: "utf8",
  });
}

test("classifier reads awkward file names verbatim", () => {
  for (const file of AWKWARD) {
    const repo = prRepo(["README.md", file]);
    try {
      const run = runClassifier(repo);
      assert.equal(run.status, 0, run.stderr);
      assert.match(run.stdout, /^unit_python=true$/m, JSON.stringify(file));
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }
  const docs = prRepo(["docs/a.md"]);
  try {
    const run = runClassifier(docs);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /^unit_python=false$/m);
  } finally {
    rmSync(docs, { recursive: true, force: true });
  }
});

test("parseChangedFiles splits on NUL and drops a trailing CR", () => {
  assert.deepEqual(parseChangedFiles(""), []);
  assert.deepEqual(parseChangedFiles("a\nb\0package.json\r\0"), [
    "a\nb",
    "package.json",
  ]);
  assert.throws(() => parseChangedFiles("a\0b"), /NUL-terminated/);
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
      assert.match(run.stderr, /^Changed files: 1$/m, JSON.stringify(file));
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

// The final job's shell, read from required-checks.yml and run under bash, so
// these cases test the gate that actually runs, not a copy of it.
function verdictScript() {
  const lines = readFileSync(
    ".github/workflows/required-checks.yml",
    "utf8",
  ).split("\n");
  const step = lines.indexOf("      - name: Check every selected area passed");
  assert.ok(step >= 0, "no verdict step");
  const run = lines.indexOf("        run: |", step);
  assert.ok(run > step, "verdict step has no run block");
  const body = [];
  for (const line of lines.slice(run + 1)) {
    if (line !== "" && !line.startsWith("          ")) break;
    body.push(line.slice(10));
  }
  return body.join("\n");
}

const ALL_SKIPPED = {
  CHANGES: "success",
  LINT: "skipped",
  LINT_WANTED: "false",
  TYPECHECK: "skipped",
  TYPECHECK_WANTED: "false",
  UNIT_TYPESCRIPT: "skipped",
  UNIT_TYPESCRIPT_WANTED: "false",
  UNIT_PYTHON: "skipped",
  UNIT_PYTHON_WANTED: "false",
};

function verdict(env) {
  const result = spawnSync("bash", ["-c", verdictScript()], {
    env: { PATH: process.env.PATH, ...env },
    encoding: "utf8",
  });
  return { status: result.status, out: result.stdout + result.stderr };
}

test("verdict: unselected areas skipped and selected areas passed is green", () => {
  assert.equal(verdict(ALL_SKIPPED).status, 0);
  assert.equal(
    verdict({ ...ALL_SKIPPED, LINT: "success", LINT_WANTED: "true" }).status,
    0,
  );
});

test("verdict: a selected area that did not succeed is red", () => {
  for (const result of ["skipped", "failure", "cancelled", ""]) {
    const { status } = verdict({
      ...ALL_SKIPPED,
      LINT: result,
      LINT_WANTED: "true",
    });
    assert.notEqual(status, 0, `lint result '${result}'`);
  }
  assert.notEqual(verdict({ ...ALL_SKIPPED, CHANGES: "failure" }).status, 0);
});

test("verdict: an empty, missing or unknown area output is red", () => {
  for (const key of Object.keys(ALL_SKIPPED).filter((k) =>
    k.endsWith("_WANTED"),
  )) {
    for (const wanted of ["", "True", "1", "yes"]) {
      const { status, out } = verdict({ ...ALL_SKIPPED, [key]: wanted });
      assert.notEqual(status, 0, `${key}='${wanted}' passed:\n${out}`);
    }
    const missing = { ...ALL_SKIPPED };
    delete missing[key];
    assert.notEqual(verdict(missing).status, 0, `${key} unset passed`);
  }
});

test("verdict job runs unless the run was cancelled", () => {
  const caller = readFileSync(".github/workflows/required-checks.yml", "utf8");
  const job = caller.split("\n  required-checks:\n")[1];
  assert.match(job, /^    if: \$\{\{ !cancelled\(\) \}\}$/m);
});

// The classifier must run however it is invoked and never throw on import.
const CLASSIFIER = ".github/scripts/required-checks-areas.mjs";

function runClassifierAt(script) {
  const repo = prRepo(["sdks/python/ag_ui/core/events.py"]);
  try {
    return runClassifier(repo, script);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

test("classifier prints every area as true or false", () => {
  const { status, stdout } = runClassifierAt(CLASSIFIER);
  assert.equal(status, 0);
  assert.deepEqual(stdout.trim().split("\n"), [
    "lint=false",
    "typecheck=true",
    "unit_typescript=true",
    "unit_python=true",
  ]);
});

test("classifier run through a symlink prints the same areas", () => {
  const dir = mkdtempSync(join(tmpdir(), "areas-"));
  try {
    const link = join(dir, "link.mjs");
    symlinkSync(resolve(CLASSIFIER), link);
    assert.equal(
      runClassifierAt(link).stdout,
      runClassifierAt(CLASSIFIER).stdout,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("importing the classifier with no script argument does not throw", () => {
  const { status, stdout, stderr } = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `await import(${JSON.stringify(pathToFileURL(resolve(CLASSIFIER)).href)}); console.log("ok");`,
    ],
    { input: "", encoding: "utf8" },
  );
  assert.equal(status, 0, stderr);
  assert.equal(stdout.trim(), "ok");
});

// GitHub lists a pull request's changed files with a three-dot diff: from the
// merge base to the PR head. The merge commit's diff against the base tip
// hides a change that main already has.
// https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#git-diff-comparisons
test("changed files are the three-dot diff, not the merge commit's", () => {
  const file = "sdks/python/ag_ui/core/events.py";
  const dir = prRepo([file], [file]);
  assert.equal(git(dir, "diff", "--name-only", "HEAD^1", "HEAD"), "");
  const { areas, reason, count } = classifyRange("HEAD^1", "HEAD^2", dir);
  assert.equal(reason, null);
  assert.equal(count, 1);
  assert.deepEqual(areas, { ...ALL, lint: false });
});

test("no merge base selects every area", () => {
  const shallow = mkdtempSync(join(tmpdir(), "required-checks-shallow-"));
  const source = prRepo(["docs/a.md"]);
  git(shallow, "clone", "-q", "--depth", "1", `file://${source}`, ".");
  const result = classifyRange("HEAD", "HEAD", shallow);
  assert.match(result.reason, /no merge base/);
  assert.deepEqual(result.areas, ALL);

  const dir = prRepo(["docs/a.md"]);
  git(dir, "checkout", "-q", "--orphan", "other");
  commitFiles(dir, ["docs/b.md"], "unrelated");
  assert.deepEqual(classifyRange("main", "other", dir).areas, ALL);
});

// "If the generated diff contains more than 3,000 files and the files the
// workflow filter matches are not in the first 3,000 returned by the filter,
// the workflow will not run." (workflow-syntax, git diff comparisons.) Past
// the limit the list is not GitHub's, so every area runs.
test("more than 3000 changed files selects every area", () => {
  assert.equal(MAX_FILES, 3000);
  const docs = (n) => Array.from({ length: n }, (_, i) => `docs/p${i}.md`);
  const atLimit = classifyRange("HEAD^1", "HEAD^2", prRepo(docs(3000)));
  assert.equal(atLimit.reason, null);
  assert.deepEqual(atLimit.areas, NONE);
  const over = classifyRange("HEAD^1", "HEAD^2", prRepo(docs(3001)));
  assert.match(over.reason, /3001 changed files/);
  assert.deepEqual(over.areas, ALL);
});

// GitHub filter pattern cheat sheet: `\` escapes a special character for a
// literal match, and `!` at the start negates the rest of the pattern.
// https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#filter-pattern-cheat-sheet
// This matcher does not implement escapes, and a bare `!` negates nothing,
// so both are rejected rather than read differently from GitHub.
test("backslash escapes and a bare ! are rejected", () => {
  for (const glob of ["a\\*b", "docs/\\!x.md", "!", "!!a"]) {
    assert.throws(
      () => included("a*b", ["**", glob]),
      /unsupported glob/,
      glob,
    );
  }
});

test("every area pattern uses only supported syntax", () => {
  for (const area of Object.keys(AREAS)) {
    validate(pullRequestPaths(area));
  }
});

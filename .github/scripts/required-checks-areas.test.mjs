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
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  parseYaml,
  condition,
  render,
  runStep,
  stepNamed,
} from "../../scripts/release/lib/workflow-model.mjs";
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

const NONE = Object.fromEntries(Object.keys(AREAS).map((a) => [a, false]));
const ALL = Object.fromEntries(Object.keys(AREAS).map((a) => [a, true]));

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

// The `on.push.paths` list of a workflow, read with a real (if small) YAML
// reader so a quoted `#`, extra spaces or a comment cannot drop an item.
function pushPaths(file) {
  const paths = parseYaml(readFileSync(file, "utf8"))?.on?.push?.paths;
  assert.ok(Array.isArray(paths), `${file}: no push.paths list`);
  for (const p of paths) assert.equal(typeof p, "string", file);
  return paths;
}

test("each area list is an exact copy of its workflow's push paths", () => {
  for (const [area, { workflow, paths }] of Object.entries(AREAS)) {
    assert.deepEqual(paths, pushPaths(workflow), area);
  }
});

test("release-gating workflows run through required-checks as areas", () => {
  // Once required-checks is the only required check, a workflow with its own
  // pull_request trigger can fail without blocking a merge. These guard the
  // release pipeline, so each must be a called area instead.
  const caller = readFileSync(".github/workflows/required-checks.yml", "utf8");
  const called = Object.values(AREAS).map((a) => a.workflow);
  for (const workflow of [
    ".github/workflows/test-release-scripts.yml",
    ".github/workflows/lint-release-workflows.yml",
  ]) {
    assert.ok(called.includes(workflow), `no area for ${workflow}`);
    assert.ok(caller.includes(`uses: ./${workflow}`), workflow);
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
    // its push.paths block; the pull-request copy is the lint_release area
    assert.equal(
      lint.split(`- "${file}"`).length - 1,
      1,
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
    release_scripts: false,
    lint_release: false,
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
    release_scripts: false,
    lint_release: false,
  });
  assert.deepEqual(classify(["sdks/python/ag_ui/core/events.py"]), {
    lint: false,
    typecheck: true,
    unit_typescript: true,
    unit_python: true,
    release_scripts: false,
    lint_release: false,
  });
});

test("release changes select the release areas", () => {
  assert.deepEqual(classify(["scripts/release/bump.ts"]), {
    lint: false,
    typecheck: false,
    unit_typescript: false,
    unit_python: false,
    release_scripts: true,
    lint_release: true,
  });
  // Release-script tests read every workflow file (YAML parity, token
  // mints), so any workflow change runs them.
  assert.deepEqual(classify([".github/workflows/zizmor.yml"]), {
    lint: false,
    typecheck: false,
    unit_typescript: false,
    unit_python: false,
    release_scripts: true,
    lint_release: true,
  });
  assert.equal(
    classify([".github/workflows/dojo-e2e.yml"]).release_scripts,
    true,
  );
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

test("the workflow's classify step selects areas for awkward file names", () => {
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
      // The step runs the base tip's classifier, so it is in the base commit.
      mkdirSync(join(repo, ".github/scripts"), { recursive: true });
      writeFileSync(
        join(repo, ".github/scripts/required-checks-areas.mjs"),
        readFileSync(".github/scripts/required-checks-areas.mjs"),
      );
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
      const job = callerWf.jobs.changes;
      const run = runStep(
        stepNamed(job, "Classify changed files"),
        {},
        {
          workflow: callerWf,
          job,
          cwd: repo,
        },
      );
      assert.equal(run.status, 0, run.stderr + run.stdout);
      assert.match(run.stderr, /^Changed files: 1$/m, JSON.stringify(file));
      assert.equal(run.outputs.unit_python, "true", JSON.stringify(file));
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }
});

// The gate step of required-checks.yml, run through the model's runStep (the
// runner's `bash -e`, env rendered from the step's own `${{ }}`), with
// `needs` built from each called job's result (`results`, by job name) and
// the `changes` job's `outputs`. A result or output left out renders as ''.
function runGate({ changes = "success", results = {}, outputs = {} }) {
  const job = callerWf.jobs["required-checks"];
  const needs = { changes: { result: changes, outputs } };
  for (const name of Object.values(calledJobs()))
    needs[name] = { result: results[name] };
  return runStep(
    stepNamed(job, "Check every selected area passed"),
    { needs },
    {
      workflow: callerWf,
      job,
    },
  );
}

// Every area unselected and skipped, with `lint` overridden.
function verdict({ changes, lint, lintWanted, outputs } = {}) {
  const results = Object.fromEntries(
    Object.values(calledJobs()).map((name) => [name, "skipped"]),
  );
  const out = outputs ?? only();
  if (lint !== undefined) results.lint = lint;
  if (lintWanted !== undefined) out.lint = lintWanted;
  const r = runGate({ changes, results, outputs: out });
  return { status: r.status, out: r.stdout + r.stderr };
}

test("verdict: unselected areas skipped and selected areas passed is green", () => {
  assert.equal(verdict().status, 0);
  assert.equal(verdict({ lint: "success", lintWanted: "true" }).status, 0);
});

test("verdict: a selected area that did not succeed is red", () => {
  for (const result of ["skipped", "failure", "cancelled", ""]) {
    const { status } = verdict({ lint: result, lintWanted: "true" });
    assert.notEqual(status, 0, `lint result '${result}'`);
  }
  assert.notEqual(verdict({ changes: "failure" }).status, 0);
});

test("verdict: an empty, missing or unknown area output is red", () => {
  for (const area of Object.keys(AREAS)) {
    for (const wanted of ["", "True", "1", "yes"]) {
      const { status, out } = verdict({
        outputs: { ...only(), [area]: wanted },
      });
      assert.notEqual(status, 0, `${area}='${wanted}' passed:\n${out}`);
    }
    const missing = only();
    delete missing[area];
    assert.notEqual(
      verdict({ outputs: missing }).status,
      0,
      `${area} missing passed`,
    );
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
    "release_scripts=false",
    "lint_release=false",
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
  assert.deepEqual(areas, {
    ...NONE,
    typecheck: true,
    unit_typescript: true,
    unit_python: true,
  });
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

// Runs the classify step in a throwaway repo laid out like the workflow's
// checkout: HEAD is a merge commit whose first parent is the base tip. `base`
// and `pr` map file paths to contents (null deletes).
function runClassifyStep({ base, pr }) {
  // realpath: the classifier only runs as main when argv[1] has no symlinks.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "required-checks-")));
  const env = {
    PATH: process.env.PATH,
    HOME: dir,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
  };
  const git = (...args) =>
    execFileSync("git", args, { cwd: dir, env, encoding: "utf8" });
  const write = (files) => {
    for (const [path, text] of Object.entries(files)) {
      if (text === null) {
        rmSync(join(dir, path));
      } else {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), text);
      }
    }
    git("add", "-A");
  };
  try {
    git("init", "-q", "-b", "main");
    write({ "README.md": "base\n", ...base });
    git("commit", "-q", "-m", "base");
    git("checkout", "-q", "-b", "pr");
    write(pr);
    git("commit", "-q", "-m", "pr");
    git("checkout", "-q", "main");
    git("merge", "-q", "--no-ff", "-m", "merge", "pr");
    const job = callerWf.jobs.changes;
    const step = runStep(
      stepNamed(job, "Classify changed files"),
      {},
      {
        workflow: callerWf,
        job,
        cwd: dir,
        env,
      },
    );
    assert.equal(step.status, 0, step.stderr + step.stdout);
    return step.outputs;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const allAreas = (value) =>
  Object.fromEntries(Object.keys(AREAS).map((area) => [area, String(value)]));
// A classifier a PR could substitute to select nothing.
const SELECT_NOTHING = Object.keys(AREAS)
  .map((area) => `console.log("${area}=false");`)
  .join("\n");

test("classify step runs the base branch's classifier, not the PR's", () => {
  const changed = [CLASSIFIER, "sdks/python/ag_ui/core/events.py"];
  const areas = runClassifyStep({
    base: { [CLASSIFIER]: readFileSync(CLASSIFIER, "utf8") },
    pr: { [CLASSIFIER]: SELECT_NOTHING, [changed[1]]: "x = 1\n" },
  });
  assert.deepEqual(
    areas,
    Object.fromEntries(
      Object.entries(classify(changed)).map(([k, v]) => [k, String(v)]),
    ),
  );
  assert.notDeepEqual(areas, allAreas(false));
});

test("classify step selects every area when the base has no classifier", () => {
  const areas = runClassifyStep({
    base: {},
    pr: { [CLASSIFIER]: SELECT_NOTHING, "docs/a.mdx": "x\n" },
  });
  assert.deepEqual(areas, allAreas(true));
});

// ---------------------------------------------------------------------------
// required-checks.yml itself: trigger, wiring and the final pass/fail step.
//
// Same constraint as pushPaths above: no YAML parser is installed in the
// `changes` job, so these helpers read the fixed block shape of that file and
// fail loudly when the shape changes, instead of passing on a misread.

const CALLER = ".github/workflows/required-checks.yml";

function isBlankOrComment(line) {
  return line.trim() === "" || line.trim().startsWith("#");
}

// Lines nested under the single `key:` line at exactly `indent` spaces.
function block(lines, key, indent) {
  const head = `${" ".repeat(indent)}${key}:`;
  const at = lines.flatMap((line, i) =>
    line === head || line.startsWith(`${head} `) ? [i] : [],
  );
  assert.equal(at.length, 1, `expected one '${head}' line, got ${at.length}`);
  const out = [];
  for (const line of lines.slice(at[0] + 1)) {
    if (!isBlankOrComment(line) && !line.startsWith(" ".repeat(indent + 1))) {
      break;
    }
    out.push(line);
  }
  return out;
}

// `key: value` pairs at exactly `indent` spaces, comments skipped.
function pairs(lines, indent) {
  const pad = " ".repeat(indent);
  const out = new Map();
  for (const line of lines) {
    if (
      isBlankOrComment(line) ||
      !line.startsWith(pad) ||
      line[indent] === " "
    ) {
      continue;
    }
    const m = line.slice(indent).match(/^([\w-]+):(?: (.*))?$/);
    assert.ok(m, `unexpected line: '${line}'`);
    assert.ok(!out.has(m[1]), `duplicate key '${m[1]}'`);
    out.set(m[1], m[2] ?? "");
  }
  return out;
}

function caller() {
  const lines = readFileSync(CALLER, "utf8").split("\n");
  const jobsBlock = block(lines, "jobs", 0);
  const jobs = new Map(
    [...pairs(jobsBlock, 2).keys()].map((name) => [
      name,
      block(jobsBlock, name, 2),
    ]),
  );
  return { lines, jobs };
}

// The `run: |` script and `env:` of the final job's single step.
function finalStep(jobs) {
  const job = jobs.get("required-checks");
  assert.ok(job, "no required-checks job");
  const steps = block(job, "steps", 4);
  const starts = steps.flatMap((l, i) => (/^      - /.test(l) ? [i] : []));
  assert.equal(starts.length, 1, "required-checks must have exactly one step");
  const step = steps.map((l, i) =>
    i === starts[0] ? l.replace("- ", "  ") : l,
  );
  const env = pairs(block(step, "env", 8), 10);
  const run = block(step, "run", 8);
  assert.equal(
    step.find((l) => l.startsWith("        run:")),
    "        run: |",
    "run must be a literal block",
  );
  const script = run
    .map((l) => (l.trim() === "" ? "" : l.slice(10)))
    .join("\n")
    .trimEnd();
  return { env, script };
}

// area -> the job that calls its workflow, as the caller wires it.
function areaJobs(jobs) {
  const out = {};
  for (const [name, body] of jobs) {
    const m = pairs(body, 4)
      .get("if")
      ?.match(/^needs\.changes\.outputs\.(\w+) == 'true'$/);
    if (m) {
      assert.ok(!(m[1] in out), `area ${m[1]} is called by two jobs`);
      out[m[1]] = name;
    }
  }
  return out;
}

test("required-checks.yml runs on every pull request to main, unfiltered", () => {
  const { lines } = caller();
  assert.ok(lines.includes("on:"), "trigger must be a block `on:` mapping");
  // Any other key here (paths, paths-ignore, branches-ignore, types) or any
  // other event can stop the one required check from reporting.
  assert.deepEqual(
    block(lines, "on", 0)
      .filter((l) => !isBlankOrComment(l))
      .map((l) => l.trim()),
    ["pull_request:", "branches: [main]"],
  );
});

test("every area has an output, a job, a needs entry, env and a check", () => {
  const { jobs } = caller();
  const areas = Object.keys(AREAS).sort();
  const changes = jobs.get("changes");
  assert.ok(changes, "no changes job");

  const outputs = pairs(block(changes, "outputs", 4), 6);
  assert.deepEqual([...outputs.keys()].sort(), areas, "changes.outputs");
  for (const area of areas) {
    assert.equal(
      outputs.get(area),
      `\${{ steps.areas.outputs.${area} }}`,
      area,
    );
  }

  const called = areaJobs(jobs);
  assert.deepEqual(Object.keys(called).sort(), areas, "area jobs");
  for (const [area, name] of Object.entries(called)) {
    const job = pairs(jobs.get(name), 4);
    assert.equal(job.get("needs"), "changes", name);
    assert.equal(job.get("uses"), `./${AREAS[area].workflow}`, name);
  }
  assert.deepEqual(
    [...jobs.keys()].sort(),
    ["changes", "required-checks", ...Object.values(called)].sort(),
    "jobs other than changes, the area jobs and required-checks",
  );

  const final = pairs(jobs.get("required-checks"), 4);
  assert.equal(final.get("name"), "required-checks");
  // Without an always-style condition, a failed area skips this job, and a
  // skipped required check counts as passing. !cancelled() runs it after
  // failed or skipped needs, but not after a cancelled run.
  assert.equal(final.get("if"), "${{ !cancelled() }}");
  // needs is a block list of `- job` items.
  assert.equal(final.get("needs"), "", "needs must be a block list");
  const needs = block(jobs.get("required-checks"), "needs", 4)
    .filter((l) => !isBlankOrComment(l))
    .map((l) => {
      const m = l.match(/^ {6}- ([\w-]+)$/);
      assert.ok(m, `unexpected needs line: '${l}'`);
      return m[1];
    });
  assert.deepEqual(
    needs.sort(),
    ["changes", ...Object.values(called)].sort(),
    "required-checks needs",
  );

  const { env, script } = finalStep(jobs);
  const expected = new Map([["CHANGES", "${{ needs.changes.result }}"]]);
  const checks = [];
  for (const [area, name] of Object.entries(called)) {
    const v = area.toUpperCase();
    expected.set(v, `\${{ needs.${name}.result }}`);
    expected.set(`${v}_WANTED`, `\${{ needs.changes.outputs.${area} }}`);
    checks.push(`check ${name} "\${${v}:-}" "\${${v}_WANTED:-}"`);
  }
  assert.deepEqual(
    Object.fromEntries([...env].sort()),
    Object.fromEntries([...expected].sort()),
    "required-checks env",
  );
  assert.deepEqual(
    script
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^check\s/.test(l))
      .sort(),
    checks.sort(),
    "check calls",
  );
});

test("required-checks passes only when each area succeeded or was rightly skipped", () => {
  const { jobs } = caller();
  const called = areaJobs(jobs);
  const areas = Object.keys(called);
  const RESULTS = ["success", "skipped", "failure", "cancelled"];
  // A state is [selected, result] for one area.
  const good = (selected) => [selected, selected ? "success" : "skipped"];
  const cases = [];
  // Every selection pattern with correct results, then each area in turn
  // given every result while the others stay correct.
  for (let mask = 0; mask < 1 << areas.length; mask++) {
    const base = areas.map((_, i) => good(Boolean(mask & (1 << i))));
    cases.push({ changes: "success", states: base });
    for (let i = 0; i < areas.length; i++) {
      for (const selected of [true, false]) {
        for (const result of RESULTS) {
          const states = base.slice();
          states[i] = [selected, result];
          cases.push({ changes: "success", states });
        }
      }
    }
  }
  // The classifier itself failing or being cancelled fails the check even
  // though every area job was then (correctly) skipped.
  for (const changes of ["failure", "cancelled", "skipped"]) {
    cases.push({ changes, states: areas.map(() => good(false)) });
  }
  // Two areas wrong at once.
  cases.push({
    changes: "success",
    states: areas.map((_, i) => (i < 2 ? [true, "failure"] : good(true))),
  });

  for (const { changes, states } of cases) {
    const results = {};
    const outputs = {};
    states.forEach(([selected, result], i) => {
      results[called[areas[i]]] = result;
      outputs[areas[i]] = String(selected);
    });
    const pass =
      changes === "success" &&
      states.every(([sel, res]) => res === (sel ? "success" : "skipped"));
    const run = runGate({ changes, results, outputs });
    const label = JSON.stringify({ changes, results, outputs });
    assert.equal(
      run.status,
      pass ? 0 : 1,
      `${label}\n${run.stdout}${run.stderr}`,
    );
    if (!pass) assert.match(run.stdout, /::error::/, label);
  }
});

// ---------------------------------------------------------------------------
// required-checks.yml itself: the classify step, the job outputs, the `if:` of
// each called workflow and the gate script, all taken from the workflow.

const callerWf = parseYaml(readFileSync(CALLER, "utf8"));
const NAMES = Object.keys(AREAS);
const only = (...on) =>
  Object.fromEntries(NAMES.map((a) => [a, on.includes(a) ? "true" : "false"]));

// The caller job that runs each area's workflow.
function calledJobs() {
  const out = {};
  for (const [area, { workflow }] of Object.entries(AREAS)) {
    const jobs = Object.entries(callerWf.jobs).filter(
      ([, job]) => job.uses === `./${workflow}`,
    );
    assert.equal(jobs.length, 1, `${area}: exactly one job calls ${workflow}`);
    out[area] = jobs[0][0];
  }
  return out;
}

test("no PR code runs in the changes job before the classify step", () => {
  // The test step imports scripts/release/lib/workflow-model.mjs from the PR
  // tree. Code that runs before Classify could rewrite HEAD and make every
  // area false, so only pinned remote actions may come before it.
  const steps = callerWf.jobs.changes.steps;
  const at = steps.findIndex((s) => s.id === "areas");
  assert.ok(at > 0, "no classify step after checkout");
  for (const s of steps.slice(0, at)) {
    assert.equal(s.run, undefined, `run: step '${s.name}' is before classify`);
    assert.match(
      s.uses ?? "",
      /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/,
      `step before classify is not a SHA-pinned remote action: ${s.uses}`,
    );
  }
});

function writeFiles(root, files) {
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
}

// Builds the PR merge commit GitHub checks out (first parent = base tip) and
// runs the real "Classify changed files" step in it.
function classifyPr({ base, change }) {
  const root = mkdtempSync(join(tmpdir(), "required-checks-"));
  try {
    git(root, "init", "-q", "-b", "main");
    writeFiles(root, base);
    mkdirSync(join(root, ".github/scripts"), { recursive: true });
    copyFileSync(
      ".github/scripts/required-checks-areas.mjs",
      join(root, ".github/scripts/required-checks-areas.mjs"),
    );
    git(root, "add", "-A");
    git(root, "commit", "-qm", "base");
    git(root, "checkout", "-qb", "pr");
    change(root);
    git(root, "add", "-A");
    git(root, "commit", "-qm", "pr");
    git(root, "checkout", "-q", "main");
    git(root, "merge", "-q", "--no-ff", "-m", "merge", "pr");
    const job = callerWf.jobs.changes;
    const step = stepNamed(job, "Classify changed files");
    const r = runStep(step, {}, { workflow: callerWf, job, cwd: root });
    assert.equal(r.status, 0, r.stderr);
    const renamesSeen = git(root, "diff", "--name-only", "HEAD^1", "HEAD");
    return { ...r, renamesSeen };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// What the `changes` job hands to `needs.changes.outputs`.
function jobOutputs(stepOutputs) {
  return Object.fromEntries(
    Object.entries(callerWf.jobs.changes.outputs).map(([k, v]) => [
      k,
      render(v, { steps: { areas: { outputs: stepOutputs } } }),
    ]),
  );
}

test("classify step writes each area to GITHUB_OUTPUT for the changed file", () => {
  const r = classifyPr({
    base: { "README.md": "x\n", "sdks/python/ag_ui/core/events.py": "a\n" },
    change: (root) =>
      writeFiles(root, { "sdks/python/ag_ui/core/events.py": "b\n" }),
  });
  // The classifier reports the count on stderr.
  assert.match(r.stderr, /^Changed files: 1$/m);
  const want = only("typecheck", "unit_typescript", "unit_python");
  assert.deepEqual(r.outputs, want);
  assert.deepEqual(jobOutputs(r.outputs), want);
});

test("classify step lists both sides of a rename across areas", () => {
  const body = "same content, so git sees a rename\n".repeat(20);
  const r = classifyPr({
    base: { "sdks/python/ag_ui/old.py": body },
    change: (root) => {
      rmSync(join(root, "sdks/python/ag_ui/old.py"));
      writeFiles(root, { "docs/new.md": body });
    },
  });
  // Without --no-renames git would list only the new side.
  assert.equal(r.renamesSeen.trim(), "docs/new.md");
  assert.deepEqual(r.outputs, only("typecheck", "unit_python"));
});

test("classify step selects nothing for a docs-only change", () => {
  const r = classifyPr({
    base: { "docs/a.md": "a\n" },
    change: (root) => writeFiles(root, { "docs/a.md": "b\n" }),
  });
  assert.deepEqual(r.outputs, only());
});

test("each called workflow runs exactly when its own area is selected", () => {
  const jobs = calledJobs();
  for (const selected of [[], ...NAMES.map((a) => [a]), NAMES]) {
    const needs = {
      changes: { result: "success", outputs: jobOutputs(only(...selected)) },
    };
    for (const [area, name] of Object.entries(jobs))
      assert.equal(
        condition(callerWf.jobs[name].if, { needs }),
        selected.includes(area),
        `${name} with [${selected}] selected`,
      );
  }
});

// Runs the gate script with the env its step renders from `needs`.
function gate({ changes = "success", selected = [], results = {} }) {
  return gateAfter({ changes, stepOutputs: only(...selected), results }).status;
}

// The gate step after the classify step wrote `stepOutputs`: each called job
// takes its `if:` result (success when it runs, skipped when it does not)
// unless `results` (by area) overrides it.
function gateAfter({ changes = "success", stepOutputs, results = {} }) {
  const outputs = jobOutputs(stepOutputs);
  const needs = { changes: { result: changes, outputs } };
  const byJob = {};
  for (const [area, name] of Object.entries(calledJobs())) {
    const runs = condition(callerWf.jobs[name].if, { needs });
    byJob[name] = results[area] ?? (runs ? "success" : "skipped");
  }
  return runGate({ changes, results: byJob, outputs });
}

test("the gate job waits for every area and reports unless cancelled", () => {
  const job = callerWf.jobs["required-checks"];
  assert.deepEqual(
    [...job.needs].sort(),
    ["changes", ...Object.values(calledJobs())].sort(),
  );
  // It reports after failed or skipped needs; a cancelled run reports nothing
  // rather than a false red.
  for (const status of ["success", "failure"])
    assert.equal(condition(job.if, { status }), true, status);
  assert.equal(condition(job.if, { status: "cancelled" }), false, "cancelled");
});

test("the gate passes only when each selected area succeeded and the rest skipped", () => {
  assert.equal(gate({}), 0, "nothing selected, nothing ran");
  assert.equal(gate({ selected: NAMES }), 0, "everything selected and passed");
  assert.equal(gate({ changes: "failure" }), 1, "changes failed");
  assert.equal(gate({ changes: "cancelled" }), 1, "changes cancelled");
  for (const area of NAMES) {
    assert.equal(gate({ selected: [area] }), 0, `${area} passed`);
    for (const result of ["failure", "cancelled", "skipped"])
      assert.equal(
        gate({ selected: [area], results: { [area]: result } }),
        1,
        `${area} selected and ${result}`,
      );
    assert.equal(
      gate({ selected: NAMES, results: { [area]: "failure" } }),
      1,
      `${area} failed among all`,
    );
    assert.equal(
      gate({ results: { [area]: "success" } }),
      1,
      `${area} ran although not selected`,
    );
  }
});

// ---------------------------------------------------------------------------
// Base/PR area skew. The classify step runs the base branch's classifier but
// the PR's workflow, so a PR that adds or renames an area has a key the base
// classifier never prints. These run the real step through runStep, so with
// the runner's command line for a step with no `shell:` (bash -e).

// The classify step in a PR merge commit whose base tip has `baseClassifier`
// as its classifier; the PR changes only a docs file.
function classifyWithBase(baseClassifier) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "required-checks-")));
  try {
    git(root, "init", "-q", "-b", "main");
    writeFiles(root, {
      "README.md": "x\n",
      "docs/a.md": "a\n",
      [CLASSIFIER]: baseClassifier,
    });
    git(root, "add", "-A");
    git(root, "commit", "-qm", "base");
    git(root, "checkout", "-qb", "pr");
    writeFiles(root, { "docs/a.md": "b\n" });
    git(root, "add", "-A");
    git(root, "commit", "-qm", "pr");
    git(root, "checkout", "-q", "main");
    git(root, "merge", "-q", "--no-ff", "-m", "merge", "pr");
    const job = callerWf.jobs.changes;
    const step = stepNamed(job, "Classify changed files");
    return runStep(step, {}, { workflow: callerWf, job, cwd: root });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// The gate step run on the `changes` job's real step outputs, each called
// job taking its `if:` result unless `results` overrides it.
function gateOn(stepOutputs, results = {}) {
  return gateAfter({ stepOutputs, results });
}

// The real classifier with one area taken out of AREAS: a base branch from
// before the PR added that area.
function classifierWithout(area) {
  const text = readFileSync(CLASSIFIER, "utf8");
  const out = text.replace(
    new RegExp(`^  ${area}: \\{\\n[\\s\\S]*?^  \\},\\n`, "m"),
    "",
  );
  assert.notEqual(out, text, `no ${area} entry to remove`);
  return out;
}

const printAreas = (lines) =>
  lines.map((l) => `console.log(${JSON.stringify(l)});`).join("\n");

test("an area the base classifier lacks is selected with a warning and can pass", () => {
  for (const area of NAMES) {
    const r = classifyWithBase(classifierWithout(area));
    assert.equal(r.status, 0, `${area}: ${r.stdout}${r.stderr}`);
    assert.match(
      r.stdout,
      new RegExp(`^::warning::.*'${area}' area.*selecting it\\.$`, "m"),
      area,
    );
    // Docs-only: the base classifier selects nothing, the missing area is
    // selected so its checks run.
    assert.deepEqual(r.outputs, only(area), area);
    assert.equal(gateOn(r.outputs).status, 0, `${area}: gate with it passed`);
    assert.equal(
      gateOn(r.outputs, { [area]: "failure" }).status,
      1,
      `${area}: gate with it failed`,
    );
    assert.equal(
      gateOn(r.outputs, { [area]: "skipped" }).status,
      1,
      `${area}: gate with it skipped`,
    );
  }
});

test("an area the PR no longer has is ignored with a warning", () => {
  const r = classifyWithBase(
    printAreas([...NAMES.map((a) => `${a}=false`), "old_area=true"]),
  );
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^::warning::.*'old_area'.*ignoring it\.$/m);
  assert.deepEqual(r.outputs, only());
});

test("classify step fails on empty, malformed or repeated classifier output", () => {
  const cases = {
    // Imports fine, prints nothing, exits 0: what an isMain() false
    // negative does.
    "prints nothing": "// nothing\n",
    "blank line": printAreas(["", ...NAMES.map((a) => `${a}=false`)]),
    "not true or false": printAreas(NAMES.map((a) => `${a}=yes`)),
    "no value": printAreas(["lint"]),
    "carriage return": printAreas(NAMES.map((a) => `${a}=false\r`)),
    repeated: printAreas([
      ...NAMES.map((a) => `${a}=false`),
      `${NAMES[0]}=true`,
    ]),
  };
  for (const [label, classifier] of Object.entries(cases)) {
    const r = classifyWithBase(classifier);
    assert.notEqual(r.status, 0, `${label}: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /^::error::The base branch's classifier/m, label);
    assert.deepEqual(r.outputs, {}, `${label}: nothing written`);
  }
});

test("one area list: the step's AREAS, changes.outputs, the checks and AREAS", () => {
  const run = stepNamed(callerWf.jobs.changes, "Classify changed files").run;
  const lists = run.match(/^AREAS=\((.*)\)$/gm);
  assert.equal(lists?.length, 1, "exactly one AREAS=(...) line");
  const stepList = lists[0].slice("AREAS=(".length, -1).split(" ");
  assert.deepEqual(stepList, NAMES, "classify step AREAS vs classifier AREAS");
  assert.deepEqual(
    Object.keys(callerWf.jobs.changes.outputs),
    NAMES,
    "changes.outputs vs classifier AREAS",
  );
  const gateRun = stepNamed(
    callerWf.jobs["required-checks"],
    "Check every selected area passed",
  ).run;
  const checked = [...gateRun.matchAll(/^check ([\w-]+) /gm)].map((m) => m[1]);
  const jobs = calledJobs();
  assert.deepEqual(
    checked,
    NAMES.map((a) => jobs[a]),
    "check lines vs classifier AREAS",
  );
});

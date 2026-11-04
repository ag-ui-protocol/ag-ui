// node --test .github/scripts/required-checks-gating.test.mjs
// Standalone node:test suite; no dependencies to install. The workflows are
// parsed with Ruby's standard-library YAML (Psych), which ships with Ruby on
// every GitHub-hosted Ubuntu runner, because no JavaScript YAML parser is
// installed where this runs.
//
// required-checks.yml is the one check main requires. It calls workflows
// through workflow_call, so every job in it and in those workflows feeds that
// check. The set scanned here is read from required-checks.yml itself (every
// job-level `uses: ./...`, followed into nested calls) plus the local composite
// actions their steps use, and it must equal the workflows in AREAS.
//
// A failure is kept out of the merge gate by `continue-on-error`, in either of
// two places:
//   - on a job: the job still runs and shows its own result, but its failure
//     does not fail the calling workflow;
//   - on a step (in a workflow or a composite action): the step's failure does
//     not fail its job.
// Both are read per matrix leg: a literal boolean, or `${{ matrix.<key> }}`
// with a boolean on every leg. Any other value fails the test, so the result
// is read, not guessed. A job-level form is allowed only on the upstream-
// tracking lanes below, and a step-level form only on STEP_ALLOWLIST; each
// entry carries its reason.
//
// Not covered: a job or step `if:` that skips the work (a skipped job does not
// fail the workflow) and shell that swallows its own exit status (`|| true`).
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { AREAS } from "./required-checks-areas.mjs";

const ROOT = ".github/workflows/required-checks.yml";
const PY = ".github/workflows/unit-python-sdk.yml";
const TS = ".github/workflows/unit-typescript-sdk.yml";

// Lanes whose input moves whenever an upstream project publishes: they install
// the newest release in a range, or an explicitly unpinned version. A bad
// upstream release must not block unrelated PRs, so each must be non-gating at
// job level (a step-level form alone would leave the install step gating).
// `leg` selects matrix legs by their values; null means every leg of the job.
const UPSTREAM_TRACKING = [
  {
    workflow: PY,
    job: "adk-compatibility",
    leg: { adk: ">=2,<3" },
    reason: '`uv pip install "google-adk>=2,<3"`: the newest ADK 2.x',
  },
  {
    workflow: PY,
    job: "adk-middleware-python-adk-2x",
    leg: null,
    reason: 'the "Force google-adk 2.x" step installs `google-adk>=2,<3`',
  },
  {
    workflow: PY,
    job: "aws-strands-python-latest",
    leg: null,
    reason: '"Upgrade to the newest published strands-agents"',
  },
  {
    workflow: PY,
    job: "crewai-python",
    leg: { crewai: "crewai>=1.15.7,<2" },
    reason: '`--upgrade-package crewai "crewai>=1.15.7,<2"`: the newest 1.x',
  },
  {
    workflow: PY,
    job: "crewai-python-litellm-boundaries",
    leg: { bound: "ceiling" },
    reason: "the ceiling leg resolves `litellm>=1.70.4,<2` at install time",
  },
  {
    workflow: TS,
    job: "aws-strands-typescript-latest",
    leg: { sdk: "latest" },
    reason: '`pnpm add -D "@strands-agents/sdk@latest"`',
  },
  {
    workflow: TS,
    job: "adk-js-latest",
    leg: null,
    reason: "`pnpm update -D @google/adk`: the newest ADK 2.x",
  },
];

// Step-level continue-on-error that is intended. Each sits inside a lane that
// is already non-gating at job level (UPSTREAM_TRACKING); the step form keeps
// the job green so the result is reported as a warning and a summary.
// `step` is the step's id, or its name when it has no id.
const STEP_ALLOWLIST = [
  {
    workflow: PY,
    job: "adk-middleware-python-adk-2x",
    leg: null,
    step: "adk2x-tests",
    reason: "the suite is known red under google-adk 2.x (#1947)",
  },
  {
    workflow: PY,
    job: "crewai-python-litellm-boundaries",
    leg: { bound: "ceiling" },
    step: "boundary-tests",
    reason: "the ceiling leg tests the newest litellm 1.x, which drifts",
  },
];

// Lanes pinned to the lockfile or to a declared floor. Named here so that a
// rename or a removed leg fails loudly instead of dropping out of the check
// that covers every lane, and so that they must have no non-gating form at
// all, at job or step level.
const PINNED = [
  { workflow: PY, job: "adk-compatibility", leg: { adk: "==1.28.1" } },
  { workflow: PY, job: "adk-middleware-python", leg: null },
  { workflow: PY, job: "aws-strands-python", leg: null },
  { workflow: PY, job: "aws-strands-python-declared-floor", leg: null },
  { workflow: PY, job: "langgraph-python-declared-floor", leg: null },
  { workflow: PY, job: "crewai-python", leg: { crewai: "crewai==1.15.7" } },
  {
    workflow: PY,
    job: "crewai-python-litellm-boundaries",
    leg: { bound: "floor" },
  },
  {
    workflow: TS,
    job: "aws-strands-typescript-latest",
    leg: { sdk: "declared-floor" },
  },
  { workflow: TS, job: "typescript", leg: null },
];

const cache = new Map();
function loadYaml(file) {
  if (!cache.has(file)) {
    const json = execFileSync(
      "ruby",
      [
        "-ryaml",
        "-rjson",
        "-e",
        "puts JSON.generate(YAML.safe_load(File.read(ARGV[0])))",
        file,
      ],
      { encoding: "utf8" },
    );
    cache.set(file, JSON.parse(json));
  }
  return cache.get(file);
}

// required-checks.yml, then every workflow it calls (and they call), in the
// order they are first reached. A call that is not a local path is not
// modelled, so it fails.
function discoverWorkflows(root, load = loadYaml) {
  const order = [];
  const visit = (file) => {
    if (order.includes(file)) return;
    order.push(file);
    for (const [name, job] of Object.entries(load(file).jobs ?? {})) {
      if (job.uses === undefined) continue;
      assert.match(
        job.uses,
        /^\.\/\.github\/workflows\/[^/]+\.ya?ml$/,
        `${file} ${name}: only local reusable workflows are modelled`,
      );
      visit(job.uses.slice(2));
    }
  };
  visit(root);
  return order;
}

// The local composite action a step runs, or null. Remote actions are out of
// scope: their steps are not in this repository.
function compositeAction(uses) {
  if (typeof uses !== "string" || !uses.startsWith("./")) return null;
  const dir = uses.slice(2).replace(/\/$/, "");
  const file = [`${dir}/action.yml`, `${dir}/action.yaml`].find(existsSync);
  assert.ok(file, `${uses}: no action.yml`);
  return file;
}

// The legs GitHub expands a matrix into ("Expanding or adding matrix
// configurations", docs.github.com/en/actions/how-tos/write-workflows/
// choose-what-workflows-do/run-job-variations): the product of the list-valued
// keys (the original combinations), then each `include` entry is merged into
// every ORIGINAL combination it can join without overwriting an original
// value, and added as a combination of its own when it can join none. An entry
// never matches a combination an earlier entry added, and it may overwrite a
// value an earlier entry merged in.
function legs(job) {
  const matrix = job.strategy?.matrix;
  if (matrix === undefined) return [{}];
  assert.ok(
    matrix !== null && typeof matrix === "object" && !Array.isArray(matrix),
    "a matrix expression is not modelled",
  );
  const { include = [], exclude, ...axes } = matrix;
  assert.equal(exclude, undefined, "matrix exclude is not modelled");
  assert.ok(Array.isArray(include), "matrix.include must be a list");
  let original = [{}];
  for (const [key, values] of Object.entries(axes)) {
    assert.ok(Array.isArray(values), `matrix.${key} must be a list`);
    original = original.flatMap((leg) =>
      values.map((v) => ({ ...leg, [key]: v })),
    );
  }
  if (Object.keys(axes).length === 0) original = [];
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const added = [];
  for (const entry of include) {
    const joins = original.filter((leg) =>
      Object.entries(entry).every(([k, v]) => !(k in axes) || same(leg[k], v)),
    );
    if (joins.length === 0) added.push({ ...entry });
    for (const leg of joins) Object.assign(leg, entry);
  }
  return [...original, ...added];
}

// continue-on-error for one leg.
function continuesOnError(value, leg, label) {
  if (value === undefined || typeof value === "boolean") return value === true;
  const m =
    typeof value === "string" &&
    /^\$\{\{\s*matrix\.([A-Za-z_][\w-]*)\s*\}\}$/.exec(value);
  assert.ok(
    m,
    `${label}: unsupported continue-on-error ${JSON.stringify(value)}`,
  );
  assert.equal(
    typeof leg[m[1]],
    "boolean",
    `${label}: matrix.${m[1]} must be a boolean on every leg`,
  );
  return leg[m[1]];
}

// Every step-level continue-on-error a leg would take, following local
// composite actions. Composite steps cannot read `matrix`, so they are
// evaluated with no leg values and any expression there fails.
function stepForms(steps, leg, label, load, where = "") {
  const out = [];
  for (const [i, step] of (steps ?? []).entries()) {
    const id = step.id ?? step.name ?? `#${i}`;
    if (continuesOnError(step["continue-on-error"], leg, `${label} ${id}`)) {
      out.push(`${where}${id}`);
    }
    const action = compositeAction(step.uses);
    if (action === null) continue;
    const runs = load(action).runs ?? {};
    if (runs.using !== "composite") continue;
    out.push(
      ...stepForms(runs.steps, {}, `${label} ${action}`, load, `${action}:`),
    );
  }
  return out;
}

// One record per job and leg of every scanned workflow.
function lanes(workflows, load = loadYaml) {
  const out = [];
  for (const workflow of workflows) {
    for (const [job, definition] of Object.entries(load(workflow).jobs)) {
      for (const leg of legs(definition)) {
        const label = `${workflow} ${job} ${JSON.stringify(leg)}`;
        out.push({
          workflow,
          job,
          leg,
          label,
          jobLevel: continuesOnError(
            definition["continue-on-error"],
            leg,
            label,
          ),
          steps: stepForms(definition.steps, leg, label, load),
        });
      }
    }
  }
  return out;
}

const matches = (entry, lane) =>
  entry.workflow === lane.workflow &&
  entry.job === lane.job &&
  (!entry.leg ||
    Object.entries(entry.leg).every(([k, v]) => lane.leg[k] === v));

// Every non-gating form that no allowlist entry accounts for.
function unexplained(all) {
  const out = [];
  for (const lane of all) {
    if (lane.jobLevel && !UPSTREAM_TRACKING.some((e) => matches(e, lane))) {
      out.push(`${lane.label}: job-level continue-on-error`);
    }
    for (const step of lane.steps) {
      const ok = STEP_ALLOWLIST.some(
        (e) => matches(e, lane) && e.step === step,
      );
      if (!ok) out.push(`${lane.label}: step ${step} continue-on-error`);
    }
  }
  return out;
}

function selected(all, entry) {
  const chosen = all.filter((lane) => matches(entry, lane));
  assert.ok(
    chosen.length > 0,
    `${entry.workflow} ${entry.job}: no leg ${JSON.stringify(entry.leg)}`,
  );
  return chosen;
}

const WORKFLOWS = discoverWorkflows(ROOT);
const LANES = lanes(WORKFLOWS);

test("the scanned workflows are exactly the ones required-checks.yml calls", () => {
  const called = WORKFLOWS.filter((f) => f !== ROOT).sort();
  const areas = [...new Set(Object.values(AREAS).map((a) => a.workflow))];
  assert.deepEqual(called, areas.sort());
  assert.ok(called.length > 0);
});

test("every allowlist entry has a reason", () => {
  for (const entry of [...UPSTREAM_TRACKING, ...STEP_ALLOWLIST]) {
    assert.ok(entry.reason?.trim(), `${entry.job}: no reason`);
  }
});

test("every upstream-tracking lane is excluded from the merge gate", () => {
  const gating = UPSTREAM_TRACKING.flatMap((e) => selected(LANES, e))
    .filter((lane) => !lane.jobLevel)
    .map((lane) => lane.label);
  assert.deepEqual(
    gating,
    [],
    "these lanes track an upstream release but gate merges",
  );
});

test("every step allowlist entry is in use and inside a non-gating lane", () => {
  for (const entry of STEP_ALLOWLIST) {
    for (const lane of selected(LANES, entry)) {
      assert.ok(lane.steps.includes(entry.step), `${lane.label}: stale entry`);
      assert.ok(lane.jobLevel, `${lane.label}: the job itself gates merges`);
    }
  }
});

test("the pinned and floor lanes have no non-gating form", () => {
  for (const lane of PINNED.flatMap((e) => selected(LANES, e))) {
    assert.equal(lane.jobLevel, false, `${lane.label}: job-level`);
    assert.deepEqual(lane.steps, [], `${lane.label}: step-level`);
  }
});

test("no lane has a non-gating form the allowlists do not name", () => {
  assert.deepEqual(unexplained(LANES), []);
});

// Fixtures: the checks above run on parsed workflows, so a mutated copy of the
// real tree must be rejected.
function mutated(edit) {
  const docs = new Map(WORKFLOWS.map((f) => [f, structuredClone(loadYaml(f))]));
  edit((f) => docs.get(f));
  return (f) => docs.get(f) ?? loadYaml(f);
}

test("fixture: job-level continue-on-error in a called workflow is caught", () => {
  for (const value of [true, "${{ matrix.informational }}"]) {
    const load = mutated((doc) => {
      const job = doc(".github/workflows/lint-typescript.yml").jobs.lint;
      job["continue-on-error"] = value;
      if (value !== true) {
        job.strategy = { matrix: { include: [{ informational: true }] } };
      }
    });
    assert.match(
      unexplained(lanes(WORKFLOWS, load)).join("\n"),
      /lint-typescript\.yml lint .*job-level/,
    );
  }
});

test("fixture: an unsupported continue-on-error expression fails", () => {
  const load = mutated((doc) => {
    doc(".github/workflows/typecheck-typescript.yml").jobs.typecheck[
      "continue-on-error"
    ] = "${{ github.event_name == 'pull_request' }}";
  });
  assert.throws(() => lanes(WORKFLOWS, load), /unsupported continue-on-error/);
});

test("fixture: step-level continue-on-error on a pinned lane is caught", () => {
  const load = mutated((doc) => {
    const steps = doc(PY).jobs["adk-middleware-python"].steps;
    steps.find((s) => s.name === "Run tests")["continue-on-error"] = true;
  });
  assert.deepEqual(unexplained(lanes(WORKFLOWS, load)), [
    `${PY} adk-middleware-python {}: step Run tests continue-on-error`,
  ]);
});

test("fixture: step-level continue-on-error in required-checks.yml is caught", () => {
  const load = mutated((doc) => {
    const steps = doc(ROOT).jobs.changes.steps;
    steps.find(
      (s) => s.name === "Test the area classifier and the gating lanes",
    )["continue-on-error"] = true;
  });
  assert.match(
    unexplained(lanes(WORKFLOWS, load)).join("\n"),
    /required-checks\.yml changes .*step Test the area classifier/,
  );
});

test("fixture: a nested reusable workflow call is discovered", () => {
  const load = (f) =>
    f === ROOT
      ? { jobs: { a: { uses: "./.github/workflows/x.yml" } } }
      : f.endsWith("x.yml")
        ? { jobs: { b: { uses: "./.github/workflows/y.yml" } } }
        : { jobs: {} };
  assert.deepEqual(discoverWorkflows(ROOT, load), [
    ROOT,
    ".github/workflows/x.yml",
    ".github/workflows/y.yml",
  ]);
  assert.throws(
    () =>
      discoverWorkflows(ROOT, () => ({
        jobs: { a: { uses: "octo/repo/.github/workflows/z.yml@v1" } },
      })),
    /only local reusable workflows/,
  );
});

test("legs: the GitHub docs include example", () => {
  const matrix = {
    fruit: ["apple", "pear"],
    animal: ["cat", "dog"],
    include: [
      { color: "green" },
      { color: "pink", animal: "cat" },
      { fruit: "apple", shape: "circle" },
      { fruit: "banana" },
      { fruit: "banana", animal: "cat" },
    ],
  };
  assert.deepEqual(legs({ strategy: { matrix } }), [
    { fruit: "apple", animal: "cat", color: "pink", shape: "circle" },
    { fruit: "apple", animal: "dog", color: "green", shape: "circle" },
    { fruit: "pear", animal: "cat", color: "pink" },
    { fruit: "pear", animal: "dog", color: "green" },
    { fruit: "banana" },
    { fruit: "banana", animal: "cat" },
  ]);
});

test("legs: an include with no axis key joins every original leg", () => {
  const matrix = {
    sdk: ["floor", "latest"],
    include: [{ informational: false }],
  };
  assert.deepEqual(legs({ strategy: { matrix } }), [
    { sdk: "floor", informational: false },
    { sdk: "latest", informational: false },
  ]);
});

test("legs: an include never joins a leg an earlier include added", () => {
  const matrix = {
    sdk: ["floor"],
    include: [{ sdk: "latest" }, { sdk: "latest", informational: true }],
  };
  assert.deepEqual(legs({ strategy: { matrix } }), [
    { sdk: "floor" },
    { sdk: "latest" },
    { sdk: "latest", informational: true },
  ]);
});

test("legs: an include-only matrix is one leg per entry", () => {
  const matrix = { include: [{ bound: "floor" }, { bound: "ceiling" }] };
  assert.deepEqual(legs({ strategy: { matrix } }), [
    { bound: "floor" },
    { bound: "ceiling" },
  ]);
  assert.throws(
    () => legs({ strategy: { matrix: "${{ fromJSON(x) }}" } }),
    /matrix expression/,
  );
});

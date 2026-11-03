// node --test .github/scripts/required-checks-gating.test.mjs
// Standalone node:test suite; no dependencies to install. The workflows are
// parsed with Ruby's standard-library YAML (Psych), which ships with Ruby on
// every GitHub-hosted Ubuntu runner, because no JavaScript YAML parser is
// installed where this runs.
//
// required-checks.yml calls these workflows through workflow_call, so every job
// in them feeds the one check main requires. A job with continue-on-error still
// runs and shows its own result, but a failure there does not fail the called
// workflow, so it does not fail required-checks. That is the only way a lane is
// kept out of the merge gate, and these tests pin which lanes use it.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const WORKFLOWS = [
  ".github/workflows/unit-python-sdk.yml",
  ".github/workflows/unit-typescript-sdk.yml",
];

// Lanes whose input moves whenever an upstream project publishes: they install
// the newest release in a range, or an explicitly unpinned version. A bad
// upstream release must not block unrelated PRs, so each must be non-gating.
// `leg` selects matrix legs by their values; null means every leg of the job.
const UPSTREAM_TRACKING = [
  // `uv pip install "google-adk>=2,<3"`: the newest ADK 2.x.
  { workflow: WORKFLOWS[0], job: "adk-compatibility", leg: { adk: ">=2,<3" } },
  // The "Force google-adk 2.x" step installs `google-adk>=2,<3`.
  { workflow: WORKFLOWS[0], job: "adk-middleware-python-adk-2x", leg: null },
  // "Upgrade to the newest published strands-agents".
  { workflow: WORKFLOWS[0], job: "aws-strands-python-latest", leg: null },
  // `--upgrade-package crewai "crewai>=1.15.7,<2"`: the newest CrewAI 1.x.
  {
    workflow: WORKFLOWS[0],
    job: "crewai-python",
    leg: { crewai: "crewai>=1.15.7,<2" },
  },
  // The ceiling leg resolves `litellm>=1.70.4,<2` at install time.
  {
    workflow: WORKFLOWS[0],
    job: "crewai-python-litellm-boundaries",
    leg: { bound: "ceiling" },
  },
  // `pnpm add -D "@strands-agents/sdk@latest"`.
  {
    workflow: WORKFLOWS[1],
    job: "aws-strands-typescript-latest",
    leg: { sdk: "latest" },
  },
  // `pnpm update -D @google/adk`: the newest ADK 2.x.
  { workflow: WORKFLOWS[1], job: "adk-js-latest", leg: null },
];

// Lanes pinned to the lockfile or to a declared floor. Named here so that a
// rename or a removed leg fails loudly instead of dropping out of the check
// below, which covers every lane not listed above.
const PINNED = [
  {
    workflow: WORKFLOWS[0],
    job: "adk-compatibility",
    leg: { adk: "==1.28.1" },
  },
  { workflow: WORKFLOWS[0], job: "adk-middleware-python", leg: null },
  { workflow: WORKFLOWS[0], job: "aws-strands-python", leg: null },
  {
    workflow: WORKFLOWS[0],
    job: "aws-strands-python-declared-floor",
    leg: null,
  },
  { workflow: WORKFLOWS[0], job: "langgraph-python-declared-floor", leg: null },
  {
    workflow: WORKFLOWS[0],
    job: "crewai-python",
    leg: { crewai: "crewai==1.15.7" },
  },
  {
    workflow: WORKFLOWS[0],
    job: "crewai-python-litellm-boundaries",
    leg: { bound: "floor" },
  },
  {
    workflow: WORKFLOWS[1],
    job: "aws-strands-typescript-latest",
    leg: { sdk: "declared-floor" },
  },
  { workflow: WORKFLOWS[1], job: "typescript", leg: null },
];

function loadJobs(file) {
  const json = execFileSync(
    "ruby",
    [
      "-ryaml",
      "-rjson",
      "-e",
      "puts JSON.generate(YAML.safe_load(File.read(ARGV[0])).fetch('jobs'))",
      file,
    ],
    { encoding: "utf8" },
  );
  return JSON.parse(json);
}

// The legs GitHub expands a matrix into: the product of the list-valued keys,
// then each `include` entry merged into every leg it matches on the keys it
// shares with them, or added as a leg of its own when it matches none.
function legs(job) {
  const matrix = job.strategy?.matrix;
  if (!matrix) return [{}];
  const { include = [], exclude, ...axes } = matrix;
  assert.equal(exclude, undefined, "matrix exclude is not modelled");
  let out = [{}];
  for (const [key, values] of Object.entries(axes)) {
    assert.ok(Array.isArray(values), `matrix.${key} must be a list`);
    out = out.flatMap((leg) => values.map((v) => ({ ...leg, [key]: v })));
  }
  if (Object.keys(axes).length === 0) out = [];
  for (const entry of include) {
    const shared = Object.keys(entry).filter((k) => k in axes);
    const matches = out.filter(
      (leg) => shared.length > 0 && shared.every((k) => leg[k] === entry[k]),
    );
    if (matches.length === 0) out.push({ ...entry });
    for (const leg of matches) {
      for (const [k, v] of Object.entries(entry)) {
        if (!(k in axes)) leg[k] = v;
      }
    }
  }
  return out;
}

// Job-level continue-on-error for one leg. Only a literal boolean or the single
// expression `${{ matrix.informational }}` is accepted, so the result is read,
// not guessed.
function continuesOnError(job, leg, label) {
  const value = job["continue-on-error"];
  if (value === undefined || typeof value === "boolean") return value === true;
  assert.equal(
    value,
    "${{ matrix.informational }}",
    `${label}: unsupported continue-on-error expression`,
  );
  assert.equal(
    typeof leg.informational,
    "boolean",
    `${label}: matrix.informational must be set on every leg`,
  );
  return leg.informational;
}

const jobs = Object.fromEntries(WORKFLOWS.map((f) => [f, loadJobs(f)]));

function selected({ workflow, job, leg }) {
  const definition = jobs[workflow][job];
  assert.ok(definition, `${workflow}: no job ${job}`);
  const chosen = legs(definition).filter(
    (l) => !leg || Object.entries(leg).every(([k, v]) => l[k] === v),
  );
  assert.ok(
    chosen.length > 0,
    `${workflow} ${job}: no leg ${JSON.stringify(leg)}`,
  );
  return chosen.map((l) => ({ definition, leg: l }));
}

function isUpstream(workflow, job, leg) {
  return UPSTREAM_TRACKING.some(
    (lane) =>
      lane.workflow === workflow &&
      lane.job === job &&
      (!lane.leg || Object.entries(lane.leg).every(([k, v]) => leg[k] === v)),
  );
}

test("every upstream-tracking lane is excluded from the merge gate", () => {
  const gating = [];
  for (const lane of UPSTREAM_TRACKING) {
    for (const { definition, leg } of selected(lane)) {
      const label = `${lane.job} ${JSON.stringify(leg)}`;
      if (!continuesOnError(definition, leg, label)) gating.push(label);
    }
  }
  assert.deepEqual(
    gating,
    [],
    "these lanes track an upstream release but gate merges",
  );
});

test("the pinned and floor lanes still gate merges", () => {
  for (const lane of PINNED) {
    for (const { definition, leg } of selected(lane)) {
      const label = `${lane.job} ${JSON.stringify(leg)}`;
      assert.equal(continuesOnError(definition, leg, label), false, label);
    }
  }
});

test("no lane outside the upstream-tracking list is non-gating", () => {
  for (const workflow of WORKFLOWS) {
    for (const [name, definition] of Object.entries(jobs[workflow])) {
      for (const leg of legs(definition)) {
        if (isUpstream(workflow, name, leg)) continue;
        const label = `${workflow} ${name} ${JSON.stringify(leg)}`;
        assert.equal(continuesOnError(definition, leg, label), false, label);
      }
    }
  }
});

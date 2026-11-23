// Pins the behaviour of scripts/release/lib/workflow-model.mjs against GitHub's
// runner and expression semantics. The workflow tests trust this model in place
// of GitHub, so each rule it claims to follow has a test here, and each
// construct it does not model must throw instead of being misread.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appToken,
  condition,
  evaluate,
  parseOutputs,
  parseYaml,
  render,
  runJob,
  runStep,
} from "./lib/workflow-model.mjs";

type Step = Record<string, unknown>;
type Job = { steps: Step[]; [key: string]: unknown };
type Workflow = { jobs?: Record<string, Job>; [key: string]: unknown };

const NO_WORKFLOW: Workflow = {};
const NO_JOB: Job = { steps: [] };

// Runs one step in a throwaway workspace.
function run(
  step: Step,
  {
    workflow = NO_WORKFLOW,
    job = NO_JOB,
    ctx = {},
    timeoutMs,
    setup,
  }: {
    workflow?: Workflow;
    job?: Job;
    ctx?: Record<string, unknown>;
    timeoutMs?: number;
    setup?: (workspace: string) => void;
  } = {},
) {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "wf-model-")));
  try {
    setup?.(workspace);
    const r = runStep(step, ctx, { workflow, job, cwd: workspace, timeoutMs });
    return { ...r, workspace };
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------- shell

test("a step with no shell: runs as `bash -e {0}`: errexit, no pipefail", () => {
  const errexit = run({ run: "false\necho after\n" });
  assert.equal(errexit.status, 1);
  assert.doesNotMatch(errexit.stdout, /after/);
  // GitHub adds pipefail only for an explicit `shell: bash`.
  const pipe = run({ run: "false | true\necho after\n" });
  assert.equal(pipe.status, 0, pipe.stderr);
  assert.match(pipe.stdout, /after/);
});

test("shell: bash runs as `bash --noprofile --norc -eo pipefail {0}`", () => {
  const r = run({ shell: "bash", run: "false | true\necho after\n" });
  assert.equal(r.status, 1);
  assert.doesNotMatch(r.stdout, /after/);
});

test("defaults.run.shell applies from the job, then the workflow; the step wins", () => {
  const pipe = { run: "false | true\necho after\n" };
  const bashDefault = { run: { shell: "bash" } };
  // Workflow default only.
  assert.equal(run(pipe, { workflow: { defaults: bashDefault } }).status, 1);
  // Job default only.
  assert.equal(
    run(pipe, { job: { steps: [], defaults: bashDefault } }).status,
    1,
  );
  // A step's own shell beats both: unsupported here, so it throws.
  assert.throws(
    () =>
      run({ ...pipe, shell: "sh" }, { workflow: { defaults: bashDefault } }),
    /unsupported shell sh/,
  );
  // A job default beats the workflow default.
  assert.throws(
    () =>
      run(pipe, {
        workflow: { defaults: bashDefault },
        job: { steps: [], defaults: { run: { shell: "pwsh" } } },
      }),
    /unsupported shell pwsh/,
  );
});

test("runJob resolves the shell from the workflow's defaults too", () => {
  const workflow = { defaults: { run: { shell: "bash" } } };
  const job = { steps: [{ id: "s", run: "false | true\n" }] };
  const r = runJob(workflow, job, {});
  assert.equal(r.steps.s.outcome, "failure");
  assert.equal(r.status, "failure");
});

// ----------------------------------------------------------- env

test("workflow, job and step env reach the script, the innermost winning", () => {
  const r = run(
    {
      env: { S: "step", J: "step-over-job" },
      run: 'echo "W=$W J=$J S=$S"\n',
    },
    {
      workflow: { env: { W: "workflow", J: "workflow" } },
      job: { steps: [], env: { J: "job" } },
    },
  );
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "W=workflow J=step-over-job S=step\n");
});

test("step env can read workflow and job env through the env context", () => {
  const r = run(
    { env: { BOTH: "${{ env.W }}-${{ env.J }}" }, run: 'echo "$BOTH"\n' },
    {
      workflow: { env: { W: "w" } },
      job: { steps: [], env: { J: "j" } },
    },
  );
  assert.equal(r.stdout, "w-j\n");
});

test("the host process environment does not leak into a step", () => {
  process.env.WF_MODEL_HOST_ONLY = "leaked";
  try {
    const r = run({ run: 'echo "[${WF_MODEL_HOST_ONLY:-}]"\n' });
    assert.equal(r.stdout, "[]\n");
  } finally {
    delete process.env.WF_MODEL_HOST_ONLY;
  }
});

// ---------------------------------------------------- run templates

test("`${{ }}` in a run: script is rendered before the script runs", () => {
  const r = run(
    {
      env: { S: "s" },
      run: "echo '${{ github.sha }} ${{ env.W }} ${{ env.S }}'\n",
    },
    { workflow: { env: { W: "w" } }, ctx: { github: { sha: "abc123" } } },
  );
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "abc123 w s\n");
});

// --------------------------------------------- working-directory

test("working-directory applies from the step, the job or the workflow", () => {
  const setup = (ws: string) => {
    for (const d of ["wf", "job", "step"]) mkdirSync(join(ws, d));
  };
  const pwd = { run: "pwd\n" };
  const wf = { defaults: { run: { "working-directory": "wf" } } };
  const job = { steps: [], defaults: { run: { "working-directory": "job" } } };
  const at = (r: { stdout: string; workspace: string }) =>
    r.stdout.trim().slice(r.workspace.length);
  assert.equal(at(run(pwd, { workflow: wf, setup })), "/wf");
  assert.equal(at(run(pwd, { workflow: wf, job, setup })), "/job");
  assert.equal(
    at(
      run(
        { ...pwd, "working-directory": "step" },
        { workflow: wf, job, setup },
      ),
    ),
    "/step",
  );
});

test("a working-directory that does not exist throws", () => {
  assert.throws(
    () => run({ "working-directory": "missing", run: "pwd\n" }),
    /working-directory/,
  );
});

// ------------------------------------------------ continue-on-error

test("continue-on-error as an expression is evaluated", () => {
  const job = (coe: unknown) => ({
    steps: [{ id: "s", "continue-on-error": coe, run: "exit 1\n" }],
  });
  const on = runJob({}, job("${{ matrix.informational }}"), {
    matrix: { informational: true },
  });
  assert.equal(on.steps.s.outcome, "failure");
  assert.equal(on.steps.s.conclusion, "success");
  assert.equal(on.status, "success");
  const off = runJob({}, job("${{ matrix.informational }}"), {
    matrix: { informational: false },
  });
  assert.equal(off.steps.s.conclusion, "failure");
  assert.equal(off.status, "failure");
  assert.equal(runJob({}, job(true), {}).status, "success");
  assert.equal(runJob({}, job(false), {}).status, "failure");
});

test("continue-on-error that is not a boolean or an expression throws", () => {
  for (const coe of ["true", "yes", 1])
    assert.throws(
      () =>
        runJob(
          {},
          { steps: [{ "continue-on-error": coe, run: "exit 1\n" }] },
          {},
        ),
      /continue-on-error/,
      String(coe),
    );
  assert.throws(
    () =>
      runJob(
        {},
        {
          steps: [{ "continue-on-error": "${{ matrix.x }}", run: "exit 1\n" }],
        },
        { matrix: { x: "yes" } },
      ),
    /continue-on-error/,
  );
});

// ------------------------------------------------- process faults

test("a step that cannot be spawned throws instead of reading as a failure", () => {
  assert.throws(() =>
    runStep(
      { run: "true\n" },
      {},
      {
        workflow: NO_WORKFLOW,
        job: NO_JOB,
        cwd: "/nonexistent/wf-model",
      },
    ),
  );
});

test("a step that outlives its modelled timeout fails as timed out", () => {
  const r = run({ run: "sleep 5\n" }, { timeoutMs: 300 });
  assert.equal(r.timedOut, true);
  assert.notEqual(r.status, 0);
});

test("runStep requires the workflow and job the step belongs to", () => {
  assert.throws(() => runStep({ run: "true\n" }, {}, {}), /workflow and job/);
});

// ----------------------------------------------------- expressions

test("&& and || short-circuit and return an operand", () => {
  assert.equal(evaluate("false && fromJSON('')", {}), false);
  assert.equal(evaluate("true || fromJSON('')", {}), true);
  assert.equal(evaluate("'' && fromJSON('').x", {}), "");
  assert.equal(evaluate("'a' && 'b'", {}), "b");
  assert.equal(evaluate("'' || 'c'", {}), "c");
  assert.equal(
    evaluate("inputs.x != '' && fromJSON(inputs.x).y", { inputs: { x: "" } }),
    false,
  );
  // The skipped side is still parsed: an unknown function is an error.
  assert.throws(() => evaluate("false && nosuch()", {}), /unknown function/);
});

test("format() un-escapes {{ and }} in one pass, and never in arguments", () => {
  assert.equal(evaluate("format('{{0}}', 'x')", {}), "{0}");
  assert.equal(evaluate("format('{0}', '{{x}}')", {}), "{{x}}");
  assert.equal(evaluate("format('{{{0}}}', 'a')", {}), "{a}");
  assert.equal(evaluate("format('{0}-{1}', 'a', 'b')", {}), "a-b");
  assert.throws(() => evaluate("format('{1}', 'a')", {}), /format/);
  assert.throws(() => evaluate("format('{', 'a')", {}), /format/);
  assert.throws(() => evaluate("format('}', 'a')", {}), /format/);
});

test("string == ignores case", () => {
  assert.equal(evaluate("'ABC' == 'abc'", {}), true);
  assert.equal(evaluate("'ABC' != 'abd'", {}), true);
});

test("an `if:` without a status function implies success()", () => {
  for (const status of ["failure", "cancelled"]) {
    assert.equal(condition(undefined, { status }), false, status);
    assert.equal(condition("true", { status }), false, status);
    assert.equal(condition("always()", { status }), true, status);
  }
  assert.equal(condition("true", {}), true);
  assert.equal(condition("failure()", { status: "failure" }), true);
});

test("render() turns each template into its string value", () => {
  assert.equal(
    render("a-${{ inputs.n }}-${{ inputs.b }}", { inputs: { n: 1, b: false } }),
    "a-1-false",
  );
});

// ----------------------------------------------------------- YAML

test("block scalar chomping: strip, clip and keep", () => {
  const doc = (h: string) => parseYaml(`a: ${h}\n  x\n  y\n\n\nb: 1\n`).a;
  assert.equal(doc("|-"), "x\ny");
  assert.equal(doc("|"), "x\ny\n");
  assert.equal(doc("|+"), "x\ny\n\n\n");
  assert.equal(doc(">-"), "x y");
  assert.equal(doc(">"), "x y\n");
  assert.equal(doc(">+"), "x y\n\n\n");
  assert.equal(parseYaml("a: |+\n  x\n").a, "x\n");
  assert.equal(parseYaml("a: |+\n  x\n\n").a, "x\n\n");
  assert.equal(parseYaml("a: |+\n\n\nb: 1\n").a, "\n\n");
});

// Lever C: the reader must agree with a real YAML parser on every workflow
// this repository has. Psych is YAML 1.1, so its `on` key (read as true) and
// integral floats are normalised to what GitHub's parser gives.
test("parseYaml matches Psych on every workflow in .github/workflows", () => {
  const dir = ".github/workflows";
  const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
  assert.ok(files.length > 20, "workflows found");
  const psych = JSON.parse(
    execFileSync(
      "ruby",
      [
        "-ryaml",
        "-rjson",
        "-e",
        `
def norm(v)
    case v
    when Hash then v.each_with_object({}) { |(k, x), h| h[k == true ? "on" : k.to_s] = norm(x) }
    when Array then v.map { |x| norm(x) }
    when Float then (v == v.to_i ? v.to_i : v)
    else v
    end
end
puts JSON.generate(ARGV.to_h { |f| [f, norm(YAML.safe_load(File.read(f)))] })
`,
        ...files.map((f) => join(dir, f)),
      ],
      { encoding: "utf8" },
    ),
  );
  for (const f of files) {
    const path = join(dir, f);
    assert.deepEqual(parseYaml(readFileSync(path, "utf8")), psych[path], path);
  }
});

// ---------------------------------------------------------- runJob

test("a skipped step reports outcome and conclusion skipped", () => {
  const r = runJob(
    {},
    {
      steps: [
        { id: "a", run: "exit 1\n" },
        { id: "b", run: "echo never\n" },
        { id: "c", if: "always()", run: "echo ran\n" },
      ],
    },
    {},
  );
  assert.deepEqual(r.steps.b, {
    outputs: {},
    outcome: "skipped",
    conclusion: "skipped",
  });
  assert.equal(r.steps.c.outcome, "success");
  assert.equal(r.status, "failure");
});

test("GITHUB_OUTPUT: the last value of a name wins", () => {
  assert.deepEqual(parseOutputs("a=1\nb=2\na=3\n"), { a: "3", b: "2" });
  const r = run({
    run: 'echo "k=1" >> "$GITHUB_OUTPUT"\necho "k=2" >> "$GITHUB_OUTPUT"\n',
  });
  assert.deepEqual(r.outputs, { k: "2" });
});

// ------------------------------------------------ closed contract (WI-5)
//
// Each construct the model does not follow exactly must throw. One row per
// "throws on" entry in the header of lib/workflow-model.mjs.

const THROWS: [string, () => unknown, RegExp][] = [
  // YAML
  ["a YAML anchor", () => parseYaml("a: &x 1\n"), /unsupported YAML node/],
  ["a YAML tag", () => parseYaml("a: !!str 1\n"), /unsupported YAML node/],
  ["a flow mapping", () => parseYaml("a: {b: 1}\n"), /flow mappings/],
  [
    "a multi-line plain scalar",
    () => parseYaml("a: x\n  y\n"),
    /multi-line plain scalar/,
  ],
  [
    "a multi-line quoted scalar",
    () => parseYaml("a: 'x\n  y'\n"),
    /multi-line quoted scalar/,
  ],
  [
    "explicit block-scalar indentation",
    () => parseYaml("a: |2\n  x\n"),
    /block scalar header/,
  ],
  [
    "a nested sequence on one line (`- - x`)",
    () => parseYaml("- - x\n"),
    /sequence entry/,
  ],
  [
    "a sequence entry as a value",
    () => parseYaml("a: - x\n"),
    /sequence entry/,
  ],
  [
    "a trailing comma in a flow sequence",
    () => parseYaml("a: [x, ]\n"),
    /flow sequence/,
  ],
  [
    "a trailing comma with no space in a flow sequence",
    () => parseYaml("a: [x,]\n"),
    /trailing comma/,
  ],
  [
    "an empty flow sequence entry",
    () => parseYaml("a: [x,,y]\n"),
    /flow sequence/,
  ],
  // Expressions
  ["an unknown function", () => evaluate("nosuch()", {}), /unknown function/],
  ["an unknown context", () => evaluate("nosuch.x", {}), /unknown context/],
  [
    "`}}` inside a string literal",
    () => render("${{ format('}}') }}", {}),
    /string literal/,
  ],
  // Runner
  [
    "a shell other than bash",
    () => run({ shell: "sh", run: "true\n" }),
    /unsupported shell/,
  ],
  [
    "a non-literal timeout-minutes",
    () => run({ "timeout-minutes": "${{ inputs.t }}", run: "true\n" }),
    /literal timeout-minutes/,
  ],
  [
    "timeout-minutes 0",
    () => run({ "timeout-minutes": 0, run: "true\n" }),
    /timeout-minutes/,
  ],
  [
    "a negative timeout-minutes",
    () => run({ "timeout-minutes": -1, run: "true\n" }),
    /timeout-minutes/,
  ],
  [
    "a missing working-directory",
    () => run({ "working-directory": "missing", run: "true\n" }),
    /working-directory/,
  ],
  [
    "an unknown step key",
    () => run({ "timeout-seconds": 1, run: "true\n" }),
    /unsupported step key timeout-seconds/,
  ],
  [
    "step env setting GITHUB_OUTPUT",
    () => run({ env: { GITHUB_OUTPUT: "/tmp/x" }, run: "true\n" }),
    /GITHUB_OUTPUT/,
  ],
  [
    "job env setting RUNNER_TEMP",
    () =>
      run(
        { run: "true\n" },
        { job: { steps: [], env: { RUNNER_TEMP: "/tmp" } } },
      ),
    /RUNNER_TEMP/,
  ],
  [
    "workflow env setting GITHUB_STEP_SUMMARY",
    () =>
      run(
        { run: "true\n" },
        { workflow: { env: { GITHUB_STEP_SUMMARY: "x" } } },
      ),
    /GITHUB_STEP_SUMMARY/,
  ],
  [
    "the env context in workflow env",
    () => run({ run: "true\n" }, { workflow: { env: { A: "${{ env.B }}" } } }),
    /env context/,
  ],
  [
    "the env context in job env",
    () =>
      run(
        { run: "true\n" },
        {
          workflow: { env: { B: "b" } },
          job: { steps: [], env: { A: "${{ env.B }}" } },
        },
      ),
    /env context/,
  ],
  [
    "an App token with no permission-* inputs",
    () => appToken({ uses: "actions/create-github-app-token@x", with: {} }),
    /permission-/,
  ],
  [
    "an App token permission that is an expression",
    () =>
      appToken({
        uses: "actions/create-github-app-token@x",
        with: { "permission-contents": "${{ inputs.p }}" },
      }),
    /permission-contents/,
  ],
  [
    "a job if: the caller did not evaluate",
    () => runJob({}, { if: "false", steps: [{ run: "true\n" }] }, {}),
    /job if/,
  ],
  [
    "job needs: the caller did not evaluate",
    () => runJob({}, { needs: "a", steps: [{ run: "true\n" }] }, {}),
    /job needs/,
  ],
  [
    "a job environment: the caller did not evaluate",
    () => runJob({}, { environment: "e", steps: [{ run: "true\n" }] }, {}),
    /job environment/,
  ],
  [
    "job continue-on-error",
    () =>
      runJob(
        {},
        { "continue-on-error": true, steps: [{ run: "exit 1\n" }] },
        {},
      ),
    /continue-on-error/,
  ],
  [
    "a job strategy",
    () =>
      runJob(
        {},
        { strategy: { matrix: { a: [1, 2] } }, steps: [{ run: "true\n" }] },
        {},
      ),
    /strategy/,
  ],
  [
    "a job container",
    () => runJob({}, { container: "node:22", steps: [{ run: "true\n" }] }, {}),
    /container/,
  ],
  [
    "a job timeout-minutes 0",
    () => runJob({}, { "timeout-minutes": 0, steps: [{ run: "true\n" }] }, {}),
    /timeout-minutes/,
  ],
  [
    "an unknown step key in runJob",
    () =>
      runJob(
        {},
        { steps: [{ uses: "a/b@c", foo: 1 }] },
        {},
        { uses: () => ({}) },
      ),
    /unsupported step key foo/,
  ],
];

for (const [name, fn, message] of THROWS)
  test(`throws on ${name}`, () => assert.throws(fn, message));

test("an empty `-` item before another item is null, as in Psych", () => {
  assert.deepEqual(parseYaml("a:\n  -\n  - x\n"), { a: [null, "x"] });
  assert.deepEqual(parseYaml("a:\n- \n- x\n"), { a: [null, "x"] });
  assert.deepEqual(parseYaml("- a\n-\n"), ["a", null]);
});

test("a flow sequence still reads plain and quoted items", () => {
  assert.deepEqual(parseYaml("a: [x, 'y', \"z\", 1]\n").a, ["x", "y", "z", 1]);
  assert.deepEqual(parseYaml("a: []\n").a, []);
});

test("a job if: the caller evaluated is accepted with the opt-in", () => {
  const r = runJob(
    {},
    {
      if: "false",
      needs: "a",
      environment: "e",
      steps: [{ id: "s", run: "true\n" }],
    },
    {},
    { jobConditionEvaluatedByCaller: true },
  );
  assert.equal(r.steps.s.outcome, "success");
});

test("RUNNER_TEMP is one directory for the whole job", () => {
  const r = runJob(
    {},
    {
      steps: [
        { id: "a", run: 'echo kept > "$RUNNER_TEMP/f"\n' },
        {
          id: "b",
          run: 'echo "v=$(cat "$RUNNER_TEMP/f")" >> "$GITHUB_OUTPUT"\n',
        },
      ],
    },
    {},
  );
  assert.equal(r.steps.b.outcome, "success");
  assert.deepEqual(r.steps.b.outputs, { v: "kept" });
});

test("each step gets its own GITHUB_OUTPUT", () => {
  const r = runJob(
    {},
    {
      steps: [
        { id: "a", run: 'echo "x=1" >> "$GITHUB_OUTPUT"\n' },
        { id: "b", run: "true\n" },
      ],
    },
    {},
  );
  assert.deepEqual(r.steps.a.outputs, { x: "1" });
  assert.deepEqual(r.steps.b.outputs, {});
});

test("a timed-out step's child processes are killed with it", () => {
  const marker = join(realpathSync(tmpdir()), `wf-orphan-${process.pid}`);
  rmSync(marker, { force: true });
  const r = run(
    { run: `(sleep 1; echo alive > "${marker}") &\nsleep 5\n` },
    { timeoutMs: 300 },
  );
  assert.equal(r.timedOut, true);
  execFileSync("sleep", ["1.5"]);
  let alive = true;
  try {
    readFileSync(marker);
  } catch {
    alive = false;
  }
  rmSync(marker, { force: true });
  assert.equal(alive, false, "a child outlived the step's timeout");
});

test("job timeout-minutes must be a positive literal", () => {
  const ok = runJob(
    {},
    { "timeout-minutes": 5, steps: [{ id: "s", run: "true\n" }] },
    {},
  );
  assert.equal(ok.status, "success");
  assert.throws(
    () => runJob({}, { "timeout-minutes": "${{ x }}", steps: [] }, {}),
    /timeout-minutes/,
  );
});

test("job outputs are rendered from the steps when the job ends", () => {
  const r = runJob(
    {},
    {
      outputs: { v: "${{ steps.s.outputs.k }}-x" },
      steps: [{ id: "s", run: 'echo "k=1" >> "$GITHUB_OUTPUT"\n' }],
    },
    {},
  );
  assert.deepEqual(r.outputs, { v: "1-x" });
});

test("with: is rendered before a uses: step sees it", () => {
  let seen: unknown;
  const r = runJob(
    {},
    {
      steps: [
        {
          id: "m",
          uses: "actions/create-github-app-token@x",
          with: {
            "private-key": "${{ secrets.K }}",
            "permission-contents": "write",
          },
        },
        {
          uses: "a/b@c",
          env: { E: "e" },
          with: { v: "${{ inputs.v }}-${{ env.E }}" },
        },
      ],
    },
    { inputs: { v: "in" }, secrets: { K: "pem" } },
    {
      uses: (step: Step) => {
        seen = step.with;
        return {};
      },
    },
  );
  assert.deepEqual(seen, { v: "in-e" });
  assert.equal(r.steps.m.outputs.token, "app:contents=write");
});

test("a job that runs past its timeout-minutes throws", () => {
  assert.throws(
    () =>
      runJob(
        {},
        { "timeout-minutes": 0.005, steps: [{ run: "sleep 0.6\n" }] },
        {},
      ),
    /job cancellation is not modelled/,
  );
});

test("in a job, a timed-out step's children die before the next step", () => {
  const marker = join(realpathSync(tmpdir()), `wf-orphan-job-${process.pid}`);
  rmSync(marker, { force: true });
  try {
    const r = runJob(
      {},
      {
        steps: [
          {
            id: "a",
            run: `(sleep 1; echo alive > "${marker}") &\nsleep 5\n`,
          },
          {
            id: "b",
            if: "always()",
            run: `sleep 1.5\ntest ! -e "${marker}"\n`,
          },
        ],
      },
      {},
      { timeoutMs: (step: Step) => (step.id === "a" ? 300 : undefined) },
    );
    assert.equal(r.log[0].timedOut, true);
    assert.equal(r.steps.b.outcome, "success", "a child outlived its step");
  } finally {
    rmSync(marker, { force: true });
  }
});

// The runner kills what a job leaves running when the job ends.
function leavesChildRunning(go: (script: string) => void) {
  const marker = join(realpathSync(tmpdir()), `wf-left-${process.pid}`);
  rmSync(marker, { force: true });
  try {
    go(`(sleep 1; echo alive > "${marker}") >/dev/null 2>&1 &\n`);
    execFileSync("sleep", ["1.5"]);
    let alive = true;
    try {
      readFileSync(marker);
    } catch {
      alive = false;
    }
    return alive;
  } finally {
    rmSync(marker, { force: true });
  }
}

test("a lone step's leftover processes are killed when it ends", () => {
  assert.equal(
    leavesChildRunning((script) => run({ run: script })),
    false,
  );
});

test("a job's leftover processes are killed when the job ends", () => {
  assert.equal(
    leavesChildRunning((script) =>
      runJob({}, { steps: [{ run: script }] }, {}),
    ),
    false,
  );
});

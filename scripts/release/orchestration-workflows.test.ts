import test from "node:test";
import assert from "node:assert/strict";
import {
  readFileSync,
  readdirSync,
  mkdtempSync,
  writeFileSync,
  chmodSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseYaml,
  render,
  condition,
  stepNamed,
  runJob,
  runStep as runModelStep,
  jobToken,
} from "./lib/workflow-model.mjs";

const canaryWorkflow = parseYaml(
  readFileSync(".github/workflows/canary.yml", "utf8"),
);
const prepareWorkflow = parseYaml(
  readFileSync(".github/workflows/prepare-release.yml", "utf8"),
);
const publishWorkflow = parseYaml(
  readFileSync(".github/workflows/publish-release.yml", "utf8"),
);
const canaryJob = canaryWorkflow.jobs.canary;
const APP_TOKEN =
  "actions/create-github-app-token@64ab729a6294000f5aa4a4bc0b73d1f32bc45510";

test("create-release-pr binds no deployment environment", () => {
  const job = prepareWorkflow.jobs["create-release-pr"];
  assert.ok(job, "missing create-release-pr job");
  assert.equal(job.environment, undefined);
});

test("canary reads and cancels runs with its own job token, scoped to the canary job", () => {
  // actions: write lets the wait step cancel a publish run that is still
  // pending at the approval deadline. Only the canary job gets it.
  assert.deepEqual(canaryWorkflow.permissions, { contents: "read" });
  assert.deepEqual(Object.keys(canaryWorkflow.jobs), ["canary"]);
  assert.deepEqual(canaryJob.permissions, {
    contents: "read",
    actions: "write",
  });
  const wait = stepNamed(canaryJob, "Wait for the publish run");
  assert.doesNotMatch(
    wait.run,
    /pending=/,
    "no `pending` output: a pending run is cancelled, never reported green",
  );
  assert.equal(canaryJob["timeout-minutes"], 180, "the agreed 180 minutes");
  assert.ok(wait["timeout-minutes"] > 60, "outlasts the one-hour app token");
  assert.ok(
    canaryJob["timeout-minutes"] >= wait["timeout-minutes"] + 15,
    "job timeout leaves room for cleanup",
  );
});

test("every canary app token is minted by the pinned action, nothing else", () => {
  const mints = canaryJob.steps.filter((s: any) =>
    String(s.uses ?? "").startsWith("actions/create-github-app-token@"),
  );
  assert.equal(mints.length, 2);
  for (const mint of mints) {
    assert.equal(mint.uses, APP_TOKEN);
    assert.ok(mint.id, `${mint.name}: a mint step needs an id`);
    // The first mint must fail the job: without its token nothing is created
    // or dispatched. Only the cleanup is left when the cleanup mint runs, so a
    // failure there must not turn the canary red: the Delete step reads its
    // outcome and leaves the ref with a warning. No timeout on either.
    const allowed = ["name", "id", "if", "uses", "with"];
    if (mint.id === "cleanup-token") allowed.push("continue-on-error");
    for (const key of Object.keys(mint))
      assert.ok(allowed.includes(key), `${mint.name}: unexpected ${key}`);
    assert.equal(mint.with["client-id"], "Iv23liBNyieHVFKABrJ3");
    assert.equal(
      mint.with["private-key"],
      "${{ secrets.DEVOPS_BOT_PRIVATE_KEY }}",
    );
  }
  const cleanup = stepNamed(
    canaryJob,
    "Mint devops-bot token for canary cleanup",
  );
  assert.deepEqual(
    Object.keys(cleanup.with).filter((k) => k.startsWith("permission-")),
    ["permission-contents"],
  );
  assert.equal(cleanup.with["permission-contents"], "write");
  assert.equal(
    cleanup["continue-on-error"],
    true,
    "a failed cleanup mint must not fail a canary that published",
  );
  const first = stepNamed(canaryJob, "Mint devops-bot token");
  assert.equal(first["continue-on-error"], undefined);
});

test("the cleanup mint runs exactly when the cleanup runs", () => {
  const mint = stepNamed(canaryJob, "Mint devops-bot token for canary cleanup");
  const del = stepNamed(canaryJob, "Delete canary ref");
  for (const status of ["success", "failure", "cancelled"])
    for (const located of ["true", "false", undefined]) {
      const ctx = {
        status,
        steps: { dispatch: { outputs: located ? { located } : {} } },
      };
      assert.equal(
        condition(mint.if, ctx),
        condition(del.if, ctx),
        `${status}/${located}`,
      );
      assert.equal(condition(del.if, ctx), located === "true");
    }
});

// --------------------------------------------------------------------------
// The canary job, run end to end: every `run:` step executes in order with the
// runner's skip rules and its `env:` rendered from the workflow. App-token
// steps yield a token naming their permissions; the job token names the job's
// permissions. A fake `gh` enforces those permissions and records which token
// each call used.

type JobFake = {
  runs?: string; // what `gh run list` prints
  watch?: "success" | "failure";
  status?: string | null; // `gh run view --json status`; null = unreadable
  del?: "ok" | "gone" | "error";
  // `gh run cancel`: "ok" makes every later status read report the run as
  // completed (conclusion cancelled); anything else fails the request.
  cancel?: "ok" | "error";
};

function fakeGh(dir: string, fake: JobFake): string {
  const log = join(dir, "gh.log");
  writeFileSync(log, "");
  const gh = join(dir, "gh");
  writeFileSync(
    gh,
    `#!${process.execPath}
const fs = require("node:fs");
const fake = ${JSON.stringify(fake)};
const args = process.argv.slice(2);
const token = process.env.GH_TOKEN ?? "";
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ token, args }) + "\\n");
const perms = Object.fromEntries(
  token.replace(/^\\w+:/, "").split(",").filter(Boolean).map((p) => p.split("=")),
);
const can = (scope, level) =>
  perms[scope] === "write" || (level === "read" && perms[scope] === "read");
const deny = () => {
  process.stderr.write("HTTP 403: Resource not accessible by integration\\n");
  process.exit(1);
};
const cmd = args.slice(0, 2).join(" ");
const cancelled = ${JSON.stringify(join(dir, "cancelled"))};
if (cmd === "api run") process.exit(2);
if (cmd === "run cancel") {
  if (!can("actions", "write")) deny();
  if (fake.cancel !== "ok") {
    process.stderr.write("HTTP 500: Internal Server Error\\n");
    process.exit(1);
  }
  fs.writeFileSync(cancelled, "");
  process.exit(0);
}
if (args[0] === "api") {
  const method = args[args.indexOf("-X") + 1];
  if (!can("contents", method === "GET" ? "read" : "write")) deny();
  if (method === "DELETE" && fake.del === "gone") {
    process.stderr.write("gh: Reference does not exist (HTTP 422)\\n");
    process.exit(1);
  }
  if (method === "DELETE" && fake.del === "error") {
    process.stderr.write("HTTP 502: Bad Gateway\\n");
    process.exit(1);
  }
  process.exit(0);
}
if (cmd === "workflow run") {
  if (!can("actions", "write")) deny();
  process.exit(0);
}
if (cmd === "run list") {
  if (!can("actions", "read")) deny();
  process.stdout.write(fake.runs ?? "");
  process.exit(0);
}
if (cmd === "run view") {
  if (!can("actions", "read")) deny();
  if (args.includes("url")) {
    process.stdout.write("https://example.test/run/" + args[2] + "\\n");
    process.exit(0);
  }
  if (fs.existsSync(cancelled)) {
    const both = args.includes("status,conclusion");
    process.stdout.write(both ? "completed cancelled\\n" : "completed\\n");
    process.exit(0);
  }
  if (fake.status === null) process.exit(1);
  process.stdout.write(fake.status + "\\n");
  process.exit(0);
}
if (cmd === "run watch") {
  if (!can("actions", "read")) deny();
  process.exit(fake.watch === "failure" ? 1 : 0);
}
process.stderr.write("fake gh: unexpected call " + args.join(" ") + "\\n");
process.exit(3);
`,
  );
  chmodSync(gh, 0o755);
  // The dispatch step polls with `sleep 6`.
  writeFileSync(join(dir, "sleep"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(dir, "sleep"), 0o755);
  return log;
}

const JOB_TOKEN = jobToken(canaryWorkflow, canaryJob);
const CLEANUP_TOKEN = "app:contents=write";

// `waitEnv` replaces literal values of the wait step's own `env:` (each key
// must be one the step sets), so a test can reach its approval deadline.
function runCanary(
  fake: JobFake,
  mintFails: (step: { id?: string }) => boolean = () => false,
  waitEnv: Record<string, string> = {},
) {
  const wait = stepNamed(canaryJob, "Wait for the publish run");
  for (const key of Object.keys(waitEnv))
    assert.ok(key in wait.env, `the wait step sets no env ${key}`);
  const job0 = {
    ...canaryJob,
    steps: canaryJob.steps.map((s: any) =>
      s === wait ? { ...s, env: { ...s.env, ...waitEnv } } : s,
    ),
  };
  const bin = mkdtempSync(join(tmpdir(), "canary-"));
  try {
    const log = fakeGh(bin, fake);
    const ctx = {
      github: {
        token: JOB_TOKEN,
        repository: "o/r",
        ref: "refs/heads/feat/x",
        ref_name: "feat/x",
        sha: "abc123",
        run_id: 77,
        run_attempt: 1,
      },
      inputs: { scope: "sdk-ts", suffix: "", dry_run: false },
      secrets: { DEVOPS_BOT_PRIVATE_KEY: "pem" },
    };
    const job = runJob(canaryWorkflow, job0, ctx, { bin, mintFails });
    const calls = readFileSync(log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { token: string; args: string[] });
    const ran = (name: string) =>
      job.log.find((l: any) => l.step.name === name);
    return { job, calls, ran };
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
}

const BRANCH = "canary/feat-x-77-1";
const isDelete = (c: { args: string[] }) =>
  c.args[0] === "api" && c.args.includes("DELETE");
const isStatus = (c: { args: string[] }) =>
  c.args.slice(0, 2).join(" ") === "run view" && c.args.includes("status");

test("canary job: the delete uses the cleanup token, the status read the job token", () => {
  const { job, calls, ran } = runCanary({
    runs: "4242",
    watch: "success",
    status: "completed",
    del: "ok",
  });
  assert.equal(job.status, "success");
  assert.equal(job.steps.dispatch.outputs.run_id, "4242");
  const watch = calls.filter((c) => c.args[1] === "watch");
  assert.deepEqual(watch, [
    {
      token: JOB_TOKEN,
      args: [
        "run",
        "watch",
        "4242",
        "--repo",
        "o/r",
        "--exit-status",
        "--interval",
        "60",
      ],
    },
  ]);
  const status = calls.filter(isStatus);
  assert.equal(status.length, 1);
  assert.equal(status[0].token, JOB_TOKEN);
  assert.equal(status[0].args[2], "4242");
  const del = calls.filter(isDelete);
  assert.equal(del.length, 1);
  assert.equal(del[0].token, CLEANUP_TOKEN);
  assert.ok(del[0].args.includes(`repos/o/r/git/refs/heads/${BRANCH}`));
  assert.match(
    ran("Delete canary ref")!.stdout,
    new RegExp(`Deleted ${BRANCH}`),
  );
});

test("canary job: a failed publish fails the job and still deletes the ref", () => {
  const { job, calls, ran } = runCanary({
    runs: "4242",
    watch: "failure",
    status: "completed",
    del: "ok",
  });
  assert.equal(job.status, "failure");
  assert.equal(ran("Wait for the publish run")!.outcome, "failure");
  assert.equal(ran("Mint devops-bot token for canary cleanup")!.ran, true);
  assert.equal(calls.filter(isDelete).length, 1);
  assert.equal(ran("Delete canary ref")!.status, 0);
});

for (const status of ["waiting", "queued", "in_progress", "pending", null]) {
  test(`canary job keeps the ref while the publish run is ${status ?? "unreadable"}`, () => {
    const { calls, ran } = runCanary({
      runs: "4242",
      watch: "failure",
      status,
      del: "ok",
    });
    assert.equal(calls.filter(isDelete).length, 0);
    assert.equal(calls.filter(isStatus)[0].token, JOB_TOKEN);
    const step = ran("Delete canary ref")!;
    assert.equal(step.status, 0);
    const why =
      status === null
        ? "Could not read the status of publish run 4242 (GitHub API error"
        : `Publish run 4242 is not finished (status: ${status}); it may still be awaiting approval.`;
    assert.ok(step.stdout.includes(`::warning::${why}`), step.stdout);
    assert.ok(step.stdout.includes(`Leaving ${BRANCH} in place`), step.stdout);
  });
}

test("canary job: a ref that is already gone is not a warning", () => {
  const { ran, calls } = runCanary({
    runs: "4242",
    watch: "success",
    status: "completed",
    del: "gone",
  });
  assert.equal(calls.filter(isDelete).length, 1);
  const step = ran("Delete canary ref")!;
  assert.equal(step.status, 0);
  assert.match(step.stdout, new RegExp(`Branch ${BRANCH} already gone`));
  assert.doesNotMatch(step.stdout, /::warning::/);
});

test("canary job: any other delete failure is a warning with the error, not a job failure", () => {
  const { job, ran } = runCanary({
    runs: "4242",
    watch: "success",
    status: "completed",
    del: "error",
  });
  const step = ran("Delete canary ref")!;
  assert.equal(step.status, 0);
  assert.equal(job.status, "success");
  assert.match(
    step.stdout,
    new RegExp(`::warning::Failed to delete canary ref ${BRANCH}`),
  );
  assert.match(step.stdout, /HTTP 502: Bad Gateway/);
  // Same as every other "ref stays" path: the command and a summary line.
  assert.ok(step.stdout.includes(`Leaving ${BRANCH} in place`), step.stdout);
  assert.ok(
    step.stdout.includes(`gh api -X DELETE repos/o/r/git/refs/heads/${BRANCH}`),
    step.stdout,
  );
  assert.match(step.summary, /Canary ref left in place/);
});

test("canary job: a failed cleanup mint leaves the ref with a warning and the job green", () => {
  const { job, calls, ran } = runCanary(
    { runs: "4242", watch: "success", status: "completed", del: "ok" },
    (step) => step.id === "cleanup-token",
  );
  assert.equal(
    ran("Mint devops-bot token for canary cleanup")!.outcome,
    "failure",
  );
  assert.equal(job.steps["cleanup-token"].conclusion, "success");
  assert.equal(job.status, "success");
  assert.equal(calls.filter(isDelete).length, 0);
  const del = ran("Delete canary ref")!;
  assert.equal(del.status, 0);
  assert.match(
    del.stdout,
    /::warning::The cleanup token could not be minted \(outcome: failure\)/,
  );
  assert.ok(del.stdout.includes(`Leaving ${BRANCH} in place`), del.stdout);
});

test("canary job: a run that was never located is never cleaned up", () => {
  const { job, calls, ran } = runCanary({ runs: "" });
  assert.equal(job.status, "failure");
  assert.equal(
    ran("Dispatch publish-release.yml on the canary ref")!.outcome,
    "failure",
  );
  assert.equal(ran("Mint devops-bot token for canary cleanup")!.ran, false);
  assert.equal(ran("Delete canary ref")!.ran, false);
  assert.equal(calls.filter(isDelete).length, 0);
});

// The approval window, end to end: WAIT_SECONDS=0 puts the wait step at its
// deadline at once, with the publish run still waiting for approval.
const isCancel = (c: { args: string[] }) =>
  c.args.slice(0, 2).join(" ") === "run cancel";

test("canary job: a run still pending at the deadline is cancelled, the job is red, the ref deleted", () => {
  const { job, calls, ran } = runCanary(
    { runs: "4242", status: "waiting", cancel: "ok", del: "ok" },
    undefined,
    { WAIT_SECONDS: "0" },
  );
  assert.equal(job.status, "failure");
  const wait = ran("Wait for the publish run")!;
  assert.equal(wait.outcome, "failure");
  const cancel = calls.filter(isCancel);
  assert.deepEqual(cancel, [
    { token: JOB_TOKEN, args: ["run", "cancel", "4242", "--repo", "o/r"] },
  ]);
  assert.match(JOB_TOKEN, /actions=write/);
  assert.match(
    wait.stdout,
    /::error::Publish run 4242 was not approved within the 0-minute approval window \(status: waiting\)\. Cancelled run 4242 so it stops holding the release-publish-prerelease concurrency group\./,
  );
  assert.equal(job.steps.wait.outputs.pending, undefined);
  // The Delete step then sees the cancelled run as completed.
  const del = calls.filter(isDelete);
  assert.equal(del.length, 1);
  assert.equal(del[0].token, CLEANUP_TOKEN);
  assert.match(
    ran("Delete canary ref")!.stdout,
    new RegExp(`Deleted ${BRANCH}`),
  );
});

test("canary job: a failed cancel at the deadline is red, names the command, and keeps the ref", () => {
  const { job, calls, ran } = runCanary(
    { runs: "4242", status: "waiting", cancel: "error", del: "ok" },
    undefined,
    { WAIT_SECONDS: "0" },
  );
  assert.equal(job.status, "failure");
  assert.equal(calls.filter(isCancel).length, 1);
  const wait = ran("Wait for the publish run")!;
  assert.match(wait.stdout, /::error::Publish run 4242 was not approved/);
  assert.match(wait.stdout, /the cancel request failed/);
  assert.ok(
    wait.stdout.includes("Cancel it with: gh run cancel 4242 --repo o/r"),
    wait.stdout,
  );
  assert.equal(calls.filter(isDelete).length, 0);
  assert.ok(
    ran("Delete canary ref")!.stdout.includes(`Leaving ${BRANCH} in place`),
  );
});

// Runs one canary step's real `run:` script through the workflow model's
// runStep (the runner's shell for the step, its env rendered from `ctx`, no
// host env) with a fake `gh` that logs every call. Each `gh run watch` /
// `gh run view` / `gh run cancel` / `gh api` call takes the next entry of its
// list (the last entry repeats):
//   watch:  "ok" | "fail" (API error, exit 1) | "hang" (never returns)
//   view:   "err" (API error, exit 1) | any other text, printed as the result
//   cancel: "ok" | "err" (500)
//   api:    "ok" | "gone" (404) | "err" (500) | "forbidden" (403)
// Any other call, a call with no list, or a value not listed here exits 3.
// `set` replaces literal values of the step's own `env:` (each key must be
// one the step sets). `timeoutMs` stands in for the step's timeout-minutes:
// the runner kills the step when it is reached.
type StepFake = {
  watch?: string[];
  view?: string[];
  cancel?: string[];
  api?: string[];
};
type StepResult = {
  status: number | null;
  log: string;
  out: string;
  outputs: Record<string, string>;
  summary: string;
};
function runCanaryStep(
  name: string,
  fake: StepFake,
  {
    ctx,
    set = {},
    timeoutMs,
  }: {
    ctx: Record<string, unknown>;
    set?: Record<string, string>;
    timeoutMs?: number;
  },
): StepResult {
  const root = mkdtempSync(join(tmpdir(), "canary-step-"));
  try {
    const log = join(root, "gh.log");
    writeFileSync(log, "");
    for (const [kind, seq] of Object.entries(fake)) {
      writeFileSync(join(root, `${kind}.seq`), seq.join("\n") + "\n");
    }
    const gh = join(root, "gh");
    writeFileSync(
      gh,
      [
        "#!/bin/bash",
        `printf '%s\\n' "$*" >> '${log}'`,
        "next() {",
        `  local f='${root}/'"$1"; local n=0`,
        '  if [ ! -s "$f" ]; then echo "fake gh: no $1 for: $ARGS" >&2; return 3; fi',
        '  [ -f "$f.n" ] && n=$(cat "$f.n")',
        '  echo $((n + 1)) > "$f.n"',
        '  local total; total=$(wc -l < "$f" | tr -d " ")',
        '  [ "$n" -ge "$total" ] && n=$((total - 1))',
        '  sed -n "$((n + 1))p" "$f"',
        "}",
        'ARGS="$*"',
        'case "$1 $2" in',
        '  "run watch") b=$(next watch.seq) || exit 3',
        '    case "$b" in',
        "      ok) exit 0 ;;",
        "      hang) exec sleep 8 ;;",
        '      fail) echo "HTTP 502: Bad Gateway" >&2; exit 1 ;;',
        "    esac ;;",
        '  "run view") b=$(next view.seq) || exit 3',
        '    if [ "$b" = err ]; then echo "HTTP 502: Bad Gateway" >&2; exit 1; fi',
        '    echo "$b"; exit 0 ;;',
        '  "run cancel") b=$(next cancel.seq) || exit 3',
        '    case "$b" in',
        "      ok) exit 0 ;;",
        '      err) echo "HTTP 500: Internal Server Error" >&2; exit 1 ;;',
        "    esac ;;",
        '  "api --silent") b=$(next api.seq) || exit 3',
        '    case "$b" in',
        "      ok) exit 0 ;;",
        '      gone) echo "Not Found (HTTP 404)" >&2; exit 1 ;;',
        '      err) echo "HTTP 500: Internal Server Error" >&2; exit 1 ;;',
        '      forbidden) echo "HTTP 403: Resource not accessible by integration" >&2; exit 1 ;;',
        "    esac ;;",
        "esac",
        // Any other call, or a scripted value the cases above do not know.
        'echo "fake gh: unexpected call: $ARGS (scripted: ${b:-none})" >&2',
        "exit 3",
        "",
      ].join("\n"),
    );
    chmodSync(gh, 0o755);
    const step = stepNamed(canaryJob, name);
    for (const key of Object.keys(set))
      assert.ok(key in (step.env ?? {}), `${name} sets no env ${key}`);
    const r = runModelStep({ ...step, env: { ...step.env, ...set } }, ctx, {
      workflow: canaryWorkflow,
      job: canaryJob,
      bin: root,
      timeoutMs,
    });
    return {
      status: r.status,
      log: readFileSync(log, "utf8"),
      out: (r.stdout ?? "") + (r.stderr ?? ""),
      outputs: r.outputs,
      summary: r.summary,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// The step contexts the wait and cleanup steps read; run id 42.
const STEP_GITHUB = { repository: "o/r", token: "job-token" };
const DISPATCHED = { outputs: { run_id: "42", located: "true" } };

function runWait(
  fake: StepFake,
  set: Record<string, string> = {},
  timeoutMs?: number,
) {
  return runCanaryStep("Wait for the publish run", fake, {
    ctx: { github: STEP_GITHUB, steps: { dispatch: DISPATCHED } },
    // Fast, bounded retries in place of the workflow's real settings.
    set: {
      WAIT_SECONDS: "60",
      RETRY_BASE_SECONDS: "0",
      MAX_WATCH_ATTEMPTS: "3",
      ...set,
    },
    timeoutMs,
  });
}

test("canary wait settings fit inside the step's approval window", () => {
  const wait = stepNamed(canaryJob, "Wait for the publish run");
  const stepSeconds = Number(wait["timeout-minutes"]) * 60;
  const waitSeconds = Number(wait.env.WAIT_SECONDS);
  const base = Number(wait.env.RETRY_BASE_SECONDS);
  const attempts = Number(wait.env.MAX_WATCH_ATTEMPTS);
  assert.ok(waitSeconds > 60 * 60, "wait must outlast the one-hour app token");
  const cancelSeconds =
    Number(wait.env.CANCEL_POLLS) * Number(wait.env.CANCEL_POLL_SECONDS);
  assert.ok(
    cancelSeconds > 0 && cancelSeconds <= 60,
    "the cancel is confirmed within about a minute",
  );
  assert.ok(
    waitSeconds + cancelSeconds <= stepSeconds - 120,
    "own deadline and the cancel finish before the step timeout",
  );
  assert.ok(
    base > 0 && attempts > 1,
    "retry has a real backoff and more than one attempt",
  );
});

test("canary wait retries a transient watch error, then succeeds", () => {
  const r = runWait({ watch: ["fail", "ok"], view: ["in_progress "] });
  assert.equal(r.status, 0, r.out);
  assert.equal(r.log.match(/^run watch /gm)?.length, 2);
  assert.match(r.out, /retrying/);
});

test("canary wait reports a failed publish as a publish failure", () => {
  const r = runWait({ watch: ["fail"], view: ["completed failure"] });
  assert.equal(r.status, 1, r.out);
  assert.equal(
    r.log.match(/^run watch /gm)?.length,
    1,
    "no retry once the run failed",
  );
  assert.match(r.out, /::error::Publish run 42 failed \(conclusion: failure\)/);
});

test("canary wait reports repeated API errors as a watch failure, not a publish failure", () => {
  const r = runWait({ watch: ["fail"], view: ["err"] });
  assert.equal(r.status, 1, r.out);
  assert.equal(r.log.match(/^run watch /gm)?.length, 3, "bounded retry");
  assert.match(r.out, /GitHub API error/);
  assert.match(r.out, /NOT a publish failure/);
});

test("canary wait reports a cancelled publish as displaced, not as a failure with a cause", () => {
  const r = runWait({ watch: ["fail"], view: ["completed cancelled"] });
  assert.equal(r.status, 1, r.out);
  assert.match(
    r.out,
    /::error::Publish run 42 was cancelled before it finished/,
  );
  assert.match(r.out, /release-publish-prerelease/);
  assert.doesNotMatch(r.out, /See that run for the cause/);
});

// The approval window: the step's own timeout is modelled as 5 s and the
// script's deadline is 2 s, with the watch hanging as it does while the
// publish run waits for a deployment approval.
function runDeadline(fake: StepFake, set: Record<string, string> = {}) {
  return runWait(
    { watch: ["hang"], ...fake },
    { WAIT_SECONDS: "2", ...set },
    5000,
  );
}

test("canary wait cancels a publish run still pending at the approval deadline, then fails", () => {
  const r = runDeadline({
    view: ["waiting ", "completed cancelled"],
    cancel: ["ok"],
  });
  assert.equal(r.status, 1, r.out);
  assert.match(r.log, /^run cancel 42 --repo o\/r$/m);
  const msg =
    "Publish run 42 was not approved within the 0-minute approval window (status: waiting). Cancelled run 42 so it stops holding the release-publish-prerelease concurrency group. Re-run this canary and approve the deployment within the window.";
  assert.ok(r.out.includes(`::error::${msg}`), r.out);
  assert.ok(r.summary.includes(msg), r.summary);
  assert.equal(r.outputs.pending, undefined);
});

test("canary wait fails with the cancel command when the cancel request fails", () => {
  const r = runDeadline({ view: ["waiting "], cancel: ["err"] });
  assert.equal(r.status, 1, r.out);
  assert.equal(r.log.match(/^run cancel /gm)?.length, 1);
  assert.equal(
    r.log.match(/^run view /gm)?.length,
    1,
    "no status polling after a failed cancel",
  );
  assert.match(r.out, /::error::Publish run 42 was not approved/);
  assert.match(r.out, /the cancel request failed/);
  assert.match(r.out, /blocks every later canary/);
  assert.ok(
    r.out.includes("Cancel it with: gh run cancel 42 --repo o/r"),
    r.out,
  );
  assert.match(r.summary, /gh run cancel 42 --repo o\/r/);
});

test("canary wait fails with the cancel command when the run does not stop after the cancel", () => {
  const r = runDeadline(
    { view: ["waiting "], cancel: ["ok"] },
    { CANCEL_POLLS: "3", CANCEL_POLL_SECONDS: "0" },
  );
  assert.equal(r.status, 1, r.out);
  assert.equal(r.log.match(/^run cancel /gm)?.length, 1);
  assert.equal(r.log.match(/^run view /gm)?.length, 1 + 3, "bounded polling");
  assert.match(
    r.out,
    /had not stopped within 0 s of the cancel \(status: waiting\)/,
  );
  assert.ok(
    r.out.includes("Cancel it with: gh run cancel 42 --repo o/r"),
    r.out,
  );
});

test("canary wait fails at the deadline on an API error and names the cancel command", () => {
  const r = runDeadline({ view: ["err"] });
  assert.equal(r.status, 1, r.out);
  assert.doesNotMatch(r.log, /^run cancel /m, "no cancel of an unknown run");
  assert.match(r.out, /could not read the status of publish run 42/);
  assert.ok(r.out.includes("gh run cancel 42 --repo o/r"), r.out);
});

test("canary wait succeeds when the run completes at the deadline, without a cancel", () => {
  const r = runDeadline({ view: ["completed success"] });
  assert.equal(r.status, 0, r.out);
  assert.doesNotMatch(r.log, /^run cancel /m);
  assert.match(r.out, /Publish run 42 succeeded\./);
});

test("canary wait fails a run that failed at the deadline, without a cancel", () => {
  const r = runDeadline({ view: ["completed failure"] });
  assert.equal(r.status, 1, r.out);
  assert.doesNotMatch(r.log, /^run cancel /m);
  assert.match(r.out, /::error::Publish run 42 failed \(conclusion: failure\)/);
});

// Runs the real cleanup script; `status` is what `gh run view` reports for the
// publish run (null = the read fails). `mint` is the cleanup-token step.
function runCleanup(
  status: string | null,
  {
    mint = { outcome: "success", outputs: { token: "app-token" } },
    api = ["ok"],
  }: {
    mint?: { outcome: string; outputs: Record<string, string> };
    api?: string[];
  } = {},
): { log: string; out: string; summary: string } {
  const r = runCanaryStep(
    "Delete canary ref",
    { view: [status ?? "err"], api },
    {
      ctx: {
        github: STEP_GITHUB,
        steps: {
          dispatch: DISPATCHED,
          slug: { outputs: { branch: "canary/x-1-1" } },
          "cleanup-token": mint,
        },
      },
    },
  );
  assert.equal(r.status, 0, r.out);
  return r;
}

for (const status of ["waiting", "queued", "in_progress", "pending", null]) {
  test(`canary cleanup keeps the ref while the publish run is ${status ?? "unreadable"}`, () => {
    const { log, out } = runCleanup(status);
    assert.doesNotMatch(log, /-X DELETE/);
    assert.match(out, /Leaving canary\/x-1-1 in place/);
  });
}

test("canary cleanup names a failed status read as a read failure", () => {
  const { out } = runCleanup(null);
  assert.match(out, /Could not read the status of publish run 42/);
  assert.doesNotMatch(out, /is not finished/);
});

test("canary cleanup says why and how to delete a ref it leaves behind", () => {
  const { out, summary } = runCleanup("waiting");
  assert.match(out, /is not finished \(status: waiting\)/);
  assert.match(
    out,
    /gh api -X DELETE repos\/o\/r\/git\/refs\/heads\/canary\/x-1-1/,
  );
  assert.match(summary, /canary\/x-1-1/);
});

test("canary cleanup skips the delete and says so when the cleanup token mint failed", () => {
  const { log, out } = runCleanup("completed", {
    mint: { outcome: "failure", outputs: {} },
  });
  assert.doesNotMatch(log, /-X DELETE/);
  assert.match(out, /cleanup token could not be minted \(outcome: failure\)/);
  assert.match(out, /Leaving canary\/x-1-1 in place/);
});

test("canary cleanup deletes the ref once the publish run completed", () => {
  const { log } = runCleanup("completed");
  assert.match(
    log,
    /api --silent -X DELETE repos\/o\/r\/git\/refs\/heads\/canary\/x-1-1/,
  );
});

test("canary cleanup tolerates a ref that is already gone", () => {
  const { out } = runCleanup("completed", { api: ["gone"] });
  assert.match(out, /Branch canary\/x-1-1 already gone/);
});

test("canary cleanup leaves the ref with the command and a summary line when the delete is refused", () => {
  const { log, out, summary } = runCleanup("completed", { api: ["forbidden"] });
  assert.match(log, /-X DELETE/);
  assert.match(out, /::warning::Failed to delete canary ref canary\/x-1-1/);
  assert.match(out, /HTTP 403: Resource not accessible by integration/);
  assert.match(out, /Leaving canary\/x-1-1 in place/);
  assert.match(
    summary,
    /Canary ref left in place.*gh api -X DELETE repos\/o\/r\/git\/refs\/heads\/canary\/x-1-1/,
  );
});

// --------------------------------------------------------------------------
// Concurrency groups, rendered from the workflows' own expressions.

// publish-release's workflow-level group for a run with this mode and ref.
function groupFor(mode: string, ref: string): string {
  return render(publishWorkflow.concurrency.group, {
    inputs: mode === "" ? {} : { mode },
    github: { ref },
  });
}

test("publish-release concurrency never cancels and no job overrides it", () => {
  assert.equal(publishWorkflow.concurrency["cancel-in-progress"], false);
  for (const [name, job] of Object.entries<any>(publishWorkflow.jobs))
    assert.equal(job.concurrency, undefined, `${name} overrides concurrency`);
});

// GitHub keeps at most one pending run per concurrency group. A newer run
// that joins the group replaces (cancels) the pending one, even with
// cancel-in-progress: false. See "Using concurrency" in the GitHub Actions
// docs: "there can be at most one running and one pending job in a
// concurrency group at any time". A canary can run for up to 180 minutes, so a
// group shared by the same branch would silently drop a queued canary when a
// third dispatch arrives. Each canary owns a unique canary ref, so it needs no
// serialization: the workflow has no group, or the group is unique per run.
test("canary concurrency cannot drop a queued run for the same ref", () => {
  const conc = canaryWorkflow.concurrency;
  if (conc === undefined) return;
  assert.equal(conc["cancel-in-progress"], false);
  const groupOf = (ref: string, run_id: number) =>
    render(conc.group, { github: { ref, run_id } });
  assert.notEqual(
    groupOf("refs/heads/a", 1),
    groupOf("refs/heads/a", 2),
    "a shared group keeps only one pending canary; key it on github.run_id",
  );
  for (const [name, job] of Object.entries<any>(canaryWorkflow.jobs))
    assert.equal(job.concurrency, undefined, `${name} overrides concurrency`);
});

test("stable publishes share the release-publish group", () => {
  // Push events leave inputs.mode empty.
  assert.equal(groupFor("", "refs/heads/main"), "release-publish");
  assert.equal(groupFor("stable", "refs/heads/main"), "release-publish");
});

test("a prerelease from a branch can never block or cancel a stable publish", () => {
  // canary.yml dispatches on canary/* refs; any non-main prerelease must stay
  // out of the stable group so a run waiting for approval cannot hold it.
  for (const ref of ["refs/heads/canary/feat-1-1", "refs/heads/feature/x"]) {
    assert.notEqual(groupFor("prerelease", ref), "release-publish", ref);
  }
});

test("a prerelease on main is serialized with stable publishes on main", () => {
  assert.equal(groupFor("prerelease", "refs/heads/main"), "release-publish");
});

test("prereleases from different branches share one serialized group", () => {
  assert.equal(
    groupFor("prerelease", "refs/heads/canary/a-1-1"),
    groupFor("prerelease", "refs/heads/canary/b-2-1"),
  );
});

// Runs the real "Compute prerelease version and bump" step through the model's
// runStep with a pinned clock and a fake pnpm, and returns the --preid it
// passed to prepare-release. Its fixed /tmp/bump-result.json path is moved
// into the scratch dir.
function canaryPreid({
  suffix,
  runId,
  runAttempt,
}: {
  suffix: string;
  runId: number;
  runAttempt: number;
}): string {
  const root = mkdtempSync(join(tmpdir(), "canary-version-"));
  try {
    const log = join(root, "pnpm.log");
    const bin = (name: string, body: string) => {
      writeFileSync(join(root, name), `#!/bin/bash\n${body}\n`);
      chmodSync(join(root, name), 0o755);
    };
    bin("date", "echo 1700000000");
    bin("pnpm", `printf '%s\\n' "$@" > '${log}'\necho '{"packages":[]}'`);
    const job = publishWorkflow.jobs.build;
    const bump = stepNamed(job, "Compute prerelease version and bump");
    const r = runModelStep(
      {
        ...bump,
        run: bump.run.replaceAll(
          "/tmp/bump-result.json",
          join(root, "bump-result.json"),
        ),
      },
      {
        github: { run_id: runId, run_attempt: runAttempt },
        inputs: { scope: "sdk-ts", suffix },
      },
      { workflow: publishWorkflow, job, bin: root },
    );
    assert.equal(r.status, 0, r.stderr);
    const args = readFileSync(log, "utf8").split("\n");
    return args[args.indexOf("--preid") + 1];
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("two canary runs in the same second with a blank suffix get distinct versions", () => {
  const a = canaryPreid({
    suffix: "",
    runId: 101,
    runAttempt: 1,
  });
  const b = canaryPreid({
    suffix: "",
    runId: 102,
    runAttempt: 1,
  });
  const c = canaryPreid({
    suffix: "",
    runId: 101,
    runAttempt: 2,
  });
  assert.match(a, /^canary\.[0-9.]+$/);
  assert.notEqual(a, b, "different runs must not share a version");
  assert.notEqual(a, c, "a re-run must not reuse the first attempt's version");
});

test("an explicit canary suffix is used as given", () => {
  assert.equal(
    canaryPreid({
      suffix: "fix-user-issue",
      runId: 101,
      runAttempt: 1,
    }),
    "canary.fix-user-issue",
  );
});

// actions/create-github-app-token deprecates `app-id` in favor of `client-id`.
// Every devops-bot mint in every workflow uses the app's client ID.
test("every devops-bot token mint uses client-id, not the deprecated app-id", () => {
  const dir = ".github/workflows";
  const mints: string[] = [];
  for (const file of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))) {
    const text = readFileSync(join(dir, file), "utf8");
    for (const part of text.split(/\n\s*- name: /).slice(1)) {
      if (!/uses: actions\/create-github-app-token@/.test(part)) continue;
      const name = `${file}: ${part.split("\n")[0]}`;
      mints.push(name);
      assert.doesNotMatch(part, /^\s*app-id:/m, `${name}: uses app-id`);
      assert.match(
        part,
        /^\s*client-id: "Iv23liBNyieHVFKABrJ3"$/m,
        `${name}: missing the devops-bot client-id`,
      );
    }
  }
  assert.equal(
    mints.length,
    4,
    `expected 4 mint steps, got:\n${mints.join("\n")}`,
  );
});

// A create-github-app-token step reads the devops-bot private key. Once a job
// has checked out the repo and run code from it (a `run:` step, or a local
// `uses: ./` action), that code can rewrite the action on disk, set BASH_ENV
// or plant a git hook, and so take the key or the token it mints. Mint before
// any repo code runs, or in a job that runs none.
const MINT_AFTER_REPO_CODE_ALLOWED: Record<string, string> = {
  // C-4: mints after `pnpm install` (lifecycle scripts), as the base branch
  // did. Phase 2 of the security remediation plan moves this mint.
  "prepare-release.yml: create-release-pr":
    "pre-existing; Phase 2 moves the mint",
};

function mintsAfterRepoCode(): string[] {
  const dir = ".github/workflows";
  const found: string[] = [];
  for (const file of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))) {
    const wf = parseYaml(readFileSync(join(dir, file), "utf8"));
    for (const [name, job] of Object.entries<any>(wf.jobs ?? {})) {
      let checkedOut = false;
      let repoCode = "";
      for (const step of job.steps ?? []) {
        const uses = String(step.uses ?? "");
        if (uses.startsWith("actions/checkout@")) checkedOut = true;
        else if (/^actions\/create-github-app-token@/.test(uses)) {
          if (repoCode)
            found.push(`${file}: ${name}: '${step.name}' after '${repoCode}'`);
        } else if (
          checkedOut &&
          (typeof step.run === "string" || uses.startsWith("./"))
        )
          repoCode ||= String(step.name ?? step.uses ?? step.run);
      }
    }
  }
  return found;
}

test("no job mints an app token after it has run repo code", () => {
  const found = mintsAfterRepoCode();
  const key = (f: string) => f.split(": ").slice(0, 2).join(": ");
  const unexpected = found.filter(
    (f) => !(key(f) in MINT_AFTER_REPO_CODE_ALLOWED),
  );
  assert.deepEqual(
    unexpected,
    [],
    `app token minted after repo code ran in the same job:\n${unexpected.join("\n")}`,
  );
  // An allowlist entry that no longer matches is stale: remove it.
  for (const allowed of Object.keys(MINT_AFTER_REPO_CODE_ALLOWED))
    assert.ok(
      found.some((f) => key(f) === allowed),
      `stale allowlist entry: ${allowed}`,
    );
});

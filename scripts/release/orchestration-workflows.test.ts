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
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseYaml,
  render,
  condition,
  stepNamed,
  runJob,
  jobToken,
} from "./lib/workflow-model.mjs";

// Step scripts that are run on their own (with a fake `gh` or `pnpm`) are cut
// out of the workflow text by their `- name:` line.
const canaryText = readFileSync(".github/workflows/canary.yml", "utf8");
const publishText = readFileSync(
  ".github/workflows/publish-release.yml",
  "utf8",
);

function step(text: string, name: string): string {
  const parts = text.split(`- name: ${name}\n`);
  assert.equal(parts.length, 2, `expected exactly one step '${name}'`);
  return parts[1].split(/\n {6}- name: /)[0];
}
function field(block: string, key: string): string | undefined {
  return block.match(new RegExp(`^ {8}${key}: (.*)$`, "m"))?.[1];
}
// The `run: |` body of a step, dedented.
function script(block: string): string {
  const lines = block.split("\n");
  const start = lines.findIndex((l) => /^ {8}run: \|$/.test(l));
  assert.ok(start >= 0, "step has no run block");
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line !== "" && !line.startsWith("          ")) break;
    body.push(line.slice(10));
  }
  return body.join("\n");
}

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

test("canary reads runs with its own job token, scoped to the canary job", () => {
  assert.deepEqual(canaryWorkflow.permissions, { contents: "read" });
  assert.deepEqual(canaryJob.permissions, {
    contents: "read",
    actions: "read",
  });
  assert.equal(canaryJob["timeout-minutes"], 180, "the agreed 180 minutes");
  const wait = stepNamed(canaryJob, "Wait for the publish run");
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
if (cmd === "api run") process.exit(2);
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

function runCanary(
  fake: JobFake,
  mintFails: (step: { id?: string }) => boolean = () => false,
) {
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
    const job = runJob(canaryWorkflow, canaryJob, ctx, { bin, mintFails });
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
  assert.match(step.stderr, /HTTP 502: Bad Gateway/);
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

// Runs a step's real `run:` script with a fake `gh` and logs every gh call.
// Each `gh run watch` / `gh run view` / `gh api` call takes the next entry of
// its list (the last entry repeats):
//   watch: "ok" | "fail" (API error, exit 1) | "hang" (never returns)
//   view:  "err" (API error, exit 1) | any other text, printed as the result
//   api:   "ok" | "gone" (404) | "err" (500)
// `timeoutMs` stands in for the step's timeout-minutes: the runner kills the
// step when it is reached.
type StepFake = { watch?: string[]; view?: string[]; api?: string[] };
// The arguments GitHub passes to bash for a `run:` step on Linux: no `shell:`
// runs `bash -e {0}`, and `shell: bash` runs
// `bash --noprofile --norc -eo pipefail {0}`. Running the script with a plain
// `bash file` would hide any command that errexit ends the step on.
function runnerShellArgs(shell: string | undefined, file: string): string[] {
  if (shell === undefined) return ["-e", file];
  if (shell === "bash")
    return ["--noprofile", "--norc", "-eo", "pipefail", file];
  throw new Error(`unmodelled shell: ${shell}`);
}
type StepResult = {
  status: number | null;
  log: string;
  out: string;
  output: string;
  summary: string;
};
function runStep(
  name: string,
  fake: StepFake,
  env: Record<string, string>,
  timeoutMs = 20000,
): StepResult {
  const root = mkdtempSync(join(tmpdir(), "canary-step-"));
  try {
    const log = join(root, "gh.log");
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
        '  [ -f "$f.n" ] && n=$(cat "$f.n")',
        '  echo $((n + 1)) > "$f.n"',
        '  local total; total=$(wc -l < "$f" | tr -d " ")',
        '  [ "$n" -ge "$total" ] && n=$((total - 1))',
        '  sed -n "$((n + 1))p" "$f"',
        "}",
        'case "$1 $2" in',
        '  "run watch") b=$(next watch.seq)',
        '    case "$b" in',
        "      ok) exit 0 ;;",
        "      hang) exec sleep 8 ;;",
        '      *) echo "HTTP 502: Bad Gateway" >&2; exit 1 ;;',
        "    esac ;;",
        '  "run view") b=$(next view.seq)',
        '    if [ "$b" = err ]; then echo "HTTP 502: Bad Gateway" >&2; exit 1; fi',
        '    echo "$b"; exit 0 ;;',
        '  "api --silent") b=$(next api.seq)',
        '    case "$b" in',
        '      gone) echo "Not Found (HTTP 404)" >&2; exit 1 ;;',
        '      err) echo "HTTP 500: Internal Server Error" >&2; exit 1 ;;',
        "      *) exit 0 ;;",
        "    esac ;;",
        "esac",
        "exit 0",
        "",
      ].join("\n"),
    );
    chmodSync(gh, 0o755);
    const block = step(canaryText, name);
    const file = join(root, "step.sh");
    writeFileSync(file, script(block));
    const output = join(root, "output");
    const summary = join(root, "summary");
    writeFileSync(output, "");
    writeFileSync(summary, "");
    const r = spawnSync("bash", runnerShellArgs(field(block, "shell"), file), {
      encoding: "utf8",
      timeout: timeoutMs,
      env: {
        ...process.env,
        PATH: `${root}:${process.env.PATH}`,
        GITHUB_REPOSITORY: "o/r",
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: summary,
        RUN_ID: "42",
        ...env,
      },
    });
    let calls = "";
    try {
      calls = readFileSync(log, "utf8");
    } catch {}
    return {
      status: r.status,
      log: calls,
      out: (r.stdout ?? "") + (r.stderr ?? ""),
      output: readFileSync(output, "utf8"),
      summary: readFileSync(summary, "utf8"),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const waitEnv = {
  GH_TOKEN: "fake",
  WAIT_SECONDS: "60",
  RETRY_BASE_SECONDS: "0",
  MAX_WATCH_ATTEMPTS: "3",
};
function runWait(
  fake: StepFake,
  env: Record<string, string> = {},
  timeoutMs?: number,
) {
  return runStep(
    "Wait for the publish run",
    fake,
    { ...waitEnv, ...env },
    timeoutMs,
  );
}

test("canary wait settings fit inside the step's approval window", () => {
  const wait = step(canaryText, "Wait for the publish run");
  const stepSeconds = Number(field(wait, "timeout-minutes")) * 60;
  const waitSeconds = Number(wait.match(/WAIT_SECONDS: "(\d+)"/)?.[1]);
  const base = Number(wait.match(/RETRY_BASE_SECONDS: "(\d+)"/)?.[1]);
  const attempts = Number(wait.match(/MAX_WATCH_ATTEMPTS: "(\d+)"/)?.[1]);
  assert.ok(waitSeconds > 60 * 60, "wait must outlast the one-hour app token");
  assert.ok(
    waitSeconds <= stepSeconds - 120,
    "own deadline fires before the step timeout",
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

test("canary wait times out with a warning while the publish still awaits approval", () => {
  // The step's own timeout is modelled as 5 s; the script's deadline is 2 s.
  const r = runWait(
    { watch: ["hang"], view: ["waiting "] },
    { WAIT_SECONDS: "2" },
    5000,
  );
  assert.equal(r.status, 0, r.out);
  assert.match(
    r.out,
    /::warning::.*still pending \(status: waiting\).*awaiting deployment approval/,
  );
  assert.match(r.output, /^pending=true$/m);
  assert.match(r.summary, /still pending/);
});

// Runs the real cleanup script; `status` is what `gh run view` reports for the
// publish run (null = the read fails).
function runCleanup(
  status: string | null,
  env: Record<string, string> = {},
  api: string[] = ["ok"],
): { log: string; out: string; summary: string } {
  const r = runStep(
    "Delete canary ref",
    { view: [status ?? "err"], api },
    {
      GH_TOKEN: "fake",
      STATUS_TOKEN: "fake",
      MINT_OUTCOME: "success",
      BRANCH: "canary/x-1-1",
      ...env,
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
    GH_TOKEN: "",
    MINT_OUTCOME: "failure",
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
  const { out } = runCleanup("completed", {}, ["gone"]);
  assert.match(out, /Branch canary\/x-1-1 already gone/);
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

// Runs the real "Compute prerelease version and bump" script with a pinned
// clock and a fake pnpm, and returns the --preid it passed to prepare-release.
function canaryPreid(env: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "canary-version-"));
  try {
    const log = join(root, "pnpm.log");
    const bin = (name: string, body: string) => {
      writeFileSync(join(root, name), `#!/bin/bash\n${body}\n`);
      chmodSync(join(root, name), 0o755);
    };
    bin("date", "echo 1700000000");
    bin("pnpm", `printf '%s\\n' "$@" > '${log}'\necho '{"packages":[]}'`);
    const file = join(root, "bump.sh");
    writeFileSync(
      file,
      script(
        step(publishText, "Compute prerelease version and bump"),
      ).replaceAll("/tmp/bump-result.json", join(root, "bump-result.json")),
    );
    const r = spawnSync("bash", [file], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${root}:${process.env.PATH}`,
        GITHUB_STEP_SUMMARY: join(root, "summary.md"),
        INPUT_SCOPE: "sdk-ts",
        ...env,
      },
    });
    assert.equal(r.status, 0, r.stderr);
    const args = readFileSync(log, "utf8").split("\n");
    return args[args.indexOf("--preid") + 1];
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("two canary runs in the same second with a blank suffix get distinct versions", () => {
  const a = canaryPreid({
    INPUT_SUFFIX: "",
    GITHUB_RUN_ID: "101",
    GITHUB_RUN_ATTEMPT: "1",
  });
  const b = canaryPreid({
    INPUT_SUFFIX: "",
    GITHUB_RUN_ID: "102",
    GITHUB_RUN_ATTEMPT: "1",
  });
  const c = canaryPreid({
    INPUT_SUFFIX: "",
    GITHUB_RUN_ID: "101",
    GITHUB_RUN_ATTEMPT: "2",
  });
  assert.match(a, /^canary\.[0-9.]+$/);
  assert.notEqual(a, b, "different runs must not share a version");
  assert.notEqual(a, c, "a re-run must not reuse the first attempt's version");
});

test("an explicit canary suffix is used as given", () => {
  assert.equal(
    canaryPreid({
      INPUT_SUFFIX: "fix-user-issue",
      GITHUB_RUN_ID: "101",
      GITHUB_RUN_ATTEMPT: "1",
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
    7,
    `expected 7 mint steps, got:\n${mints.join("\n")}`,
  );
});

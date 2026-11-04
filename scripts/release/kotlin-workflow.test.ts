import test from "node:test";
import assert from "node:assert/strict";
import {
  readFileSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  rmSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseYaml,
  condition as stepCondition,
  stepNamed,
  runJob,
  appToken,
} from "./lib/workflow-model.mjs";

const APP_TOKEN_ACTION =
  "actions/create-github-app-token@64ab729a6294000f5aa4a4bc0b73d1f32bc45510";

const workflow = readFileSync(".github/workflows/publish-release.yml", "utf8");
// No YAML parser is installed in the root. Bound extraction by top-level job
// indentation; evaluate the actual folded GitHub expressions, not a copy.
function job(name: string): string {
  const match = workflow.match(
    new RegExp(
      `^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][a-z_-]*:|$(?![\\s\\S]))`,
      "m",
    ),
  );
  assert.ok(match, `missing job ${name}`);
  return match[1];
}
function condition(block: string, indent = 4): string {
  const match = block.match(
    new RegExp(
      `^ {${indent}}if: (.*)\\n((?: {${indent + 2}}[^\\n]*\\n)*)`,
      "m",
    ),
  );
  assert.ok(match, "missing condition");
  return match[1] === ">" ? match[2].trim().replace(/\n\s*/g, " ") : match[1];
}
// GitHub allows hyphens in dotted step ids (steps.release-next-token); JS
// needs bracket access for them.
function js(expression: string): string {
  return expression.replace(/steps\.([a-z0-9-]+)/g, "steps['$1']");
}
function evaluate(
  expression: string,
  needs: any,
  mode = "stable",
  dry = false,
): boolean {
  return Boolean(
    Function(
      "needs",
      "github",
      "inputs",
      "always",
      "steps",
      `return (${js(expression)});`,
    )(
      needs,
      { event_name: "workflow_dispatch" },
      { mode, dry_run: dry },
      () => true,
      { "release-next-token": { outcome: "success" } },
    ),
  );
}
function state(kotlin = "success", mode = "stable", count = "3"): any {
  return {
    build: {
      result: "success",
      outputs: {
        mode,
        ts_count: "1",
        py_count: "1",
        dotnet_count: "1",
        java_count: "1",
        kotlin_count: count,
        pre_ts_count: "1",
        pre_has_py_packages: "true",
        pre_dotnet_count: "1",
      },
    },
    "build-kotlin": {
      result: kotlin,
      outputs: { count },
    },
    publish: { result: "success" },
    "publish-dotnet": { result: "success" },
    "publish-maven": { result: "success" },
  };
}
for (const lane of [
  "publish",
  "publish-dotnet",
  "publish-maven",
  "publish-kotlin",
]) {
  test(`${lane}: real YAML gates failure, cancellation, dry-run and accepts skipped predecessors`, () => {
    const block = job(lane);
    assert.match(block, /needs:\s*\[[^\]]*build-kotlin/);
    const expr = condition(block);
    assert.equal(evaluate(expr, state()), true);
    for (const outcome of ["failure", "cancelled"])
      assert.equal(evaluate(expr, state(outcome)), false, outcome);
    assert.equal(evaluate(expr, state(), "stable", true), false);
    const failedBuild = state();
    failedBuild.build.result = "failure";
    assert.equal(evaluate(expr, failedBuild), false);
    const skipped = state();
    skipped.publish.result = "skipped";
    skipped["publish-dotnet"].result = "skipped";
    skipped["publish-maven"].result = "skipped";
    assert.equal(evaluate(expr, skipped), true);
    if (lane !== "publish") {
      const predecessorFailure = state();
      predecessorFailure.publish.result = "failure";
      assert.equal(evaluate(expr, predecessorFailure), false);
    }
  });
}
test("canary npm/PyPI and Windows NuGet survive skipped Kotlin jobs", () => {
  for (const lane of ["publish", "publish-dotnet"])
    assert.equal(
      evaluate(condition(job(lane)), state("skipped", "prerelease", "")),
      true,
    );
  for (const lane of ["publish-maven", "publish-kotlin"])
    assert.equal(
      evaluate(condition(job(lane)), state("skipped", "prerelease", "")),
      false,
    );
});
test("stable Kotlin detection transfers only fresh same-run staging", () => {
  const build = job("build-kotlin");
  assert.equal(evaluate(condition(build), state()), true);
  assert.doesNotMatch(condition(build), /scope/);
  assert.doesNotMatch(build, /staging_required|kotlin-release.py/);
  assert.match(
    job("build"),
    /detect-java-version-changes.sh --build-system gradle/,
  );
  assert.equal(
    evaluate(condition(build), state("skipped", "stable", "0")),
    false,
  );
  assert.doesNotMatch(build, /secrets\.(?:SONATYPE|GPG)/);
  assert.match(build, /ref: \$\{\{ needs\.build\.outputs\.source_sha \}\}/);
  assert.match(build, /retention-days: 7/);
  for (const path of ["coordinates.json", "source-sha.txt"])
    assert.ok(build.includes(path));
  assert.match(build, /publish.sh --stage-only/);
  assert.doesNotMatch(
    build,
    /release-intent|metadataOnly|metadata_only|gh api|actions: read|pull-requests: read|retry --inventory/,
  );
});
test("Kotlin publish consumes selected source and deploy-only, emits packages after reconciliation", () => {
  const publish = job("publish-kotlin");
  assert.match(publish, /environment: maven/);
  assert.match(publish, /ref: \$\{\{ needs\.build\.outputs\.source_sha \}\}/);
  assert.match(publish, /--deploy-only/);
  assert.doesNotMatch(
    publish,
    /metadata_only|release-intent|gh api|retry --inventory/,
  );
  assert.doesNotMatch(publish, /preflight|kotlin-release.py|inventory.json/);
  assert.match(publish, /Verify published Kotlin POMs/);
  assert.ok(
    publish.indexOf("reconcile-release.sh") <
      publish.indexOf('echo "published_packages='),
  );
  assert.ok(
    publish.indexOf("Check staged Kotlin artifacts") <
      publish.indexOf("secrets.SONATYPE_USERNAME"),
  );
});
test("shared stable publishers checkout actual build source SHA", () => {
  assert.match(job("build"), /source_sha:/);
  for (const lane of ["publish", "publish-dotnet", "publish-maven"])
    assert.match(
      job(lane),
      /ref: \$\{\{ needs\.build\.outputs\.source_sha \}\}/,
    );
});
test("summary and notification depend on Kotlin detection and publishing", () => {
  assert.match(job("dry_run_summary"), /needs:\s*\[[^\]]*build-kotlin/);
  assert.match(job("notify"), /needs:\s*\[[^\]]*publish-kotlin/);
  assert.match(job("notify"), /KOTLIN_PACKAGES:/);
  assert.match(job("notify"), /JAVA_INTENDED/);
  assert.match(job("notify"), /KOTLIN_INTENDED/);
  assert.doesNotMatch(
    job("build"),
    /No version changes detected — nothing to publish/,
  );
});
test("Kotlin record helpers receive authenticated git configuration and identity", () => {
  const block = job("publish-kotlin");
  assert.match(block, /git config --local user.name/);
  assert.match(block, /git config --local .*insteadOf/);
  assert.ok(
    block.indexOf("Configure git for Kotlin records") <
      block.indexOf("create-tags.sh"),
  );
});
test("verified outputs follow ordinary record helpers", () => {
  const publish = job("publish-kotlin");
  assert.ok(
    publish.indexOf("Verify published Kotlin POMs") <
      publish.indexOf("create-tags.sh"),
  );
  assert.ok(
    publish.indexOf("reconcile-release.sh") <
      publish.indexOf('echo "published_packages='),
  );
  for (const command of [
    "create-tags.sh",
    "create-or-update-release.sh maven",
    "reconcile-release.sh maven",
  ])
    assert.ok(publish.includes(`${command} "$KOTLIN_PACKAGES"`));
});

for (const mode of ["stage-only", "dry-run", "deploy-only"]) {
  test(`Kotlin bridge ${mode} runs only the expected Gradle tasks`, () => {
    const root = mkdtempSync(join(tmpdir(), "kotlin-bridge-"));
    try {
      const library = join(root, "library");
      const repository = join(root, "repository");
      mkdirSync(join(library, "build/release"), { recursive: true });
      mkdirSync(join(repository, "com/test/demo/1"), { recursive: true });
      writeFileSync(
        join(repository, "com/test/demo/1/demo-1.pom"),
        "<project/>",
      );
      mkdirSync(join(library, "build/staging-deploy/com/test/demo/1"), {
        recursive: true,
      });
      writeFileSync(
        join(library, "build/staging-deploy/com/test/demo/1/demo-1.pom"),
        "<project/>",
      );
      writeFileSync(
        join(library, "build/release/coordinates.json"),
        JSON.stringify([{ groupId: "com.test", name: "demo", version: "1" }]),
      );
      writeFileSync(
        join(root, "publish.sh"),
        readFileSync("sdks/community/kotlin/publish.sh"),
      );
      const log = join(root, "tasks.log");
      const gradlew = join(library, "gradlew");
      writeFileSync(gradlew, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n`);
      chmodSync(gradlew, 0o755);
      const env = {
        ...process.env,
        ...Object.fromEntries(
          [
            "JRELEASER_MAVENCENTRAL_SONATYPE_USERNAME",
            "JRELEASER_MAVENCENTRAL_SONATYPE_PASSWORD",
            "JRELEASER_GPG_PASSPHRASE",
            "JRELEASER_GPG_PUBLIC_KEY",
            "JRELEASER_GPG_SECRET_KEY",
          ].map((name) => [name, "fixture"]),
        ),
      };
      const r = spawnSync(
        "bash",
        [
          join(root, "publish.sh"),
          `--${mode}`,
          ...(mode === "deploy-only" ? ["--repository", repository] : []),
        ],
        { encoding: "utf8", env },
      );
      assert.equal(r.status, 0, r.stderr);
      const tasks = readFileSync(log, "utf8");
      if (mode === "deploy-only") {
        assert.match(tasks, /jreleaserDeploy/);
        assert.ok(tasks.includes(`-PreleaseStagingRepository=${repository}`));
        assert.doesNotMatch(
          tasks,
          /clean|allTests|publish|exportReleaseCoordinates/,
        );
      } else {
        assert.match(tasks, /^clean/m);
        assert.match(tasks, /^allTests/m);
        assert.match(tasks, /^publish exportReleaseCoordinates/m);
        assert.doesNotMatch(tasks, /jreleaserDeploy/);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("stable no-op summary runs when Kotlin staging is skipped", () => {
  const expression = condition(job("stable_noop_summary"));
  assert.match(expression, /^always\(\)/);
  const needs = state("skipped", "stable", "0");
  for (const field of ["ts_count", "py_count", "dotnet_count", "java_count"])
    needs.build.outputs[field] = "0";
  assert.equal(evaluate(expression, needs), true);
  needs.build.result = "failure";
  assert.equal(evaluate(expression, needs), false);
});

const publishWorkflow = parseYaml(workflow);
const CLEANUP_JOB = "cleanup-release-next";
const MINT = "Mint devops-bot token for release/next cleanup";
const DELETE = "Delete release/next if present";
const WARN = "Warn if release/next was left behind";
const LANES = ["publish", "publish-dotnet", "publish-maven", "publish-kotlin"];

// Runs the cleanup job's steps as the runner would: the mint yields a token
// naming its permissions (or fails with none), and a fake `gh` records each
// call with the token it saw. `api` picks the DELETE response.
function runReleaseNextCleanup({
  api = "ok",
  mintFails = false,
}: { api?: "ok" | "gone" | "denied"; mintFails?: boolean } = {}) {
  const job = publishWorkflow.jobs[CLEANUP_JOB];
  assert.ok(job, `missing ${CLEANUP_JOB} job`);
  const bin = mkdtempSync(join(tmpdir(), "release-next-"));
  try {
    const log = join(bin, "gh.log");
    writeFileSync(log, "");
    writeFileSync(
      join(bin, "gh"),
      `#!${process.execPath}
const args = process.argv.slice(2);
require("node:fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, token: process.env.GH_TOKEN }) + "\\n");
const api = ${JSON.stringify(api)};
if (api === "gone") {
  process.stderr.write("gh: Reference does not exist (HTTP 422)\\n");
  process.exit(1);
}
if (api === "denied") {
  process.stderr.write("gh: Resource not accessible by integration (HTTP 403)\\n");
  process.exit(1);
}
process.exit(0);
`,
    );
    chmodSync(join(bin, "gh"), 0o755);
    const run = runJob(
      publishWorkflow,
      job,
      {
        needs: {},
        github: { repository: "o/r" },
        secrets: { DEVOPS_BOT_PRIVATE_KEY: "pem" },
      },
      // The lane's job if, needs and environment are pinned by the lane
      // tests above; this runs its steps as if the job started.
      { bin, mintFails: () => mintFails, jobConditionEvaluatedByCaller: true },
    );
    const calls = readFileSync(log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { args: string[]; token: string });
    const ran = (name: string) =>
      run.log.find((e: any) => e.step.name === name);
    return { run, calls, ran };
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
}

test("release/next cleanup runs in its own job with no checkout, no repo code and no job token", () => {
  const job = publishWorkflow.jobs[CLEANUP_JOB];
  assert.ok(job, `missing ${CLEANUP_JOB} job`);
  assert.deepEqual(job.needs, ["build", "build-kotlin", ...LANES]);
  assert.deepEqual(job.permissions, {});
  assert.equal(job.environment, undefined);
  assert.deepEqual(
    job.steps.map((s: any) => s.name),
    [MINT, DELETE, WARN],
  );
  for (const step of job.steps)
    assert.ok(
      !step.uses || step.uses === APP_TOKEN_ACTION,
      `${step.name}: only the pinned mint action may run here`,
    );
  assert.doesNotMatch(stepNamed(job, DELETE).run, /(^|[\s;&|(])git\s/m);
  // The publish lanes no longer touch release/next or the devops-bot key.
  for (const lane of LANES) {
    const text = JSON.stringify(publishWorkflow.jobs[lane]);
    assert.doesNotMatch(text, /release\/next|DEVOPS_BOT_PRIVATE_KEY/, lane);
  }
});

test("release/next cleanup deletes the ref through the API as the devops-bot app with a contents-only token", () => {
  const mint = stepNamed(publishWorkflow.jobs[CLEANUP_JOB], MINT);
  assert.equal(mint.uses, APP_TOKEN_ACTION);
  for (const key of Object.keys(mint))
    assert.ok(
      ["name", "id", "uses", "with", "continue-on-error"].includes(key),
      `unexpected ${key} on the mint step`,
    );
  assert.deepEqual(mint.with, {
    "client-id": "Iv23liBNyieHVFKABrJ3",
    "private-key": "${{ secrets.DEVOPS_BOT_PRIVATE_KEY }}",
    "permission-contents": "write",
  });
  assert.equal(appToken(mint), "app:contents=write");
  const { run, calls, ran } = runReleaseNextCleanup();
  assert.equal(run.status, "success");
  assert.equal(ran(DELETE)!.ran, true);
  assert.equal(ran(WARN)!.ran, false);
  assert.deepEqual(calls, [
    {
      args: [
        "api",
        "--silent",
        "-X",
        "DELETE",
        "repos/o/r/git/refs/heads/release/next",
      ],
      token: "app:contents=write",
    },
  ]);
  assert.match(ran(DELETE)!.stdout, /^Deleted release\/next$/m);
});

test("release/next cleanup treats an already-deleted ref as done", () => {
  const { run, calls, ran } = runReleaseNextCleanup({ api: "gone" });
  assert.equal(run.status, "success");
  assert.equal(calls.length, 1);
  assert.equal(run.steps["release-next-delete"].outcome, "success");
  assert.match(ran(DELETE)!.stdout, /already gone/);
  assert.equal(ran(WARN)!.ran, false);
});

// The packages are already published when the cleanup runs: a GitHub App
// outage, a key rotation or a refused delete must not turn a shipped release
// red, and must say that release/next was left behind.
test("release/next cleanup cannot fail the release after its packages are published", () => {
  const denied = runReleaseNextCleanup({ api: "denied" });
  assert.equal(denied.run.status, "success", "refused delete");
  assert.equal(denied.run.steps["release-next-delete"].outcome, "failure");
  assert.match(denied.ran(DELETE)!.stderr, /HTTP 403/);
  assert.equal(denied.ran(WARN)!.ran, true);
  assert.match(
    denied.ran(WARN)!.stdout,
    /^::warning[^\n]*release\/next[^\n]*left behind/m,
  );

  const noToken = runReleaseNextCleanup({ mintFails: true });
  assert.equal(noToken.run.status, "success", "mint failure");
  assert.equal(noToken.run.steps["release-next-token"].outcome, "failure");
  assert.equal(noToken.ran(DELETE)!.ran, false);
  assert.equal(noToken.calls.length, 0, "gh never called");
  assert.equal(noToken.ran(WARN)!.ran, true);
  assert.match(
    noToken.ran(WARN)!.stdout,
    /^::warning[^\n]*release\/next[^\n]*left behind/m,
  );
});

// ------------------------------------------------- release/next equivalence
//
// Until bd795a4ef each registry lane ran its own release/next cleanup at the
// end of the lane, and only the last lane with work did it. These are that
// cleanup's mint-step conditions, copied from bd795a4ef (publish-kotlin's had
// none); a test run at that commit checked that they matched its YAML. Each
// lane ran its cleanup only while the lane was still green, and only release
// summaries came after it, so "the old cleanup ran" means: some lane succeeded
// and its condition held.
const OLD_CLEANUP_IF: Record<string, string | undefined> = {
  publish:
    "needs.build.outputs.mode != 'prerelease' && needs.build.outputs.dotnet_count == '0' && needs.build.outputs.java_count == '0' && (needs['build-kotlin'].result == 'skipped' || (needs['build-kotlin'].result == 'success' && needs.build.outputs.kotlin_count == '0'))",
  "publish-dotnet":
    "needs.build.outputs.mode != 'prerelease' && needs.build.outputs.java_count == '0' && (needs['build-kotlin'].result == 'skipped' || (needs['build-kotlin'].result == 'success' && needs.build.outputs.kotlin_count == '0'))",
  "publish-maven":
    "(needs['build-kotlin'].result == 'skipped' || (needs['build-kotlin'].result == 'success' && needs.build.outputs.kotlin_count == '0'))",
  "publish-kotlin": undefined,
};

const RESULTS = ["success", "failure", "cancelled"];

// The status a job `if:` sees: success() is true only when every need succeeded.
const jobStatus = (needs: any) =>
  Object.values<any>(needs).every((n) => n.result === "success")
    ? "success"
    : "failure";

// Every run of the release DAG up to the lanes: each build output that a lane
// or cleanup condition reads, each trigger, and for every job whose own `if:`
// (from the YAML) lets it start, each way it can end. A job that does not
// start is skipped.
function releaseRuns(): { needs: any; github: any; inputs: any }[] {
  const runs: { needs: any; github: any; inputs: any }[] = [];
  const triggers = [
    { github: { event_name: "push" }, inputs: {} },
    { github: { event_name: "workflow_dispatch" }, inputs: { dry_run: false } },
    { github: { event_name: "workflow_dispatch" }, inputs: { dry_run: true } },
  ];
  const bits = (n: number) =>
    Array.from({ length: 1 << n }, (_, i) =>
      Array.from({ length: n }, (_, b) => ((i >> b) & 1 ? "1" : "0")),
    );
  const jobIf = (name: string, needs: any, t: any) =>
    stepCondition(publishWorkflow.jobs[name].if, {
      ...t,
      needs,
      status: jobStatus(needs),
    });
  const lanes = [
    "publish",
    "publish-dotnet",
    "publish-maven",
    "publish-kotlin",
  ];
  const extend = (needs: any, rest: string[], t: any) => {
    if (rest.length === 0) {
      runs.push({ needs, ...t });
      return;
    }
    const [name, ...more] = rest;
    const results = jobIf(name, needs, t) ? RESULTS : ["skipped"];
    for (const result of results)
      extend({ ...needs, [name]: { result } }, more, t);
  };
  for (const t of triggers)
    for (const buildResult of ["success", "failure"])
      for (const mode of ["stable", "prerelease", ""])
        for (const [ts, py, dotnet, java, kotlin, pre] of bits(6)) {
          const build = {
            result: buildResult,
            outputs: {
              mode,
              ts_count: ts,
              py_count: py,
              dotnet_count: dotnet,
              java_count: java,
              kotlin_count: kotlin,
              pre_ts_count: pre,
              pre_has_py_packages: pre === "1" ? "true" : "false",
              pre_dotnet_count: pre,
            },
          };
          extend({ build }, ["build-kotlin", ...lanes], t);
        }
  return runs;
}

function oldCleanupRan(run: { needs: any; github: any; inputs: any }) {
  return Object.entries(OLD_CLEANUP_IF).some(
    ([lane, expr]) =>
      run.needs[lane].result === "success" &&
      stepCondition(expr, { ...run, status: "success" }),
  );
}

function decisionTable(decide: (run: any) => boolean) {
  const rows = new Map<string, { old: boolean; now: boolean; n: number }>();
  let mismatches = 0;
  for (const run of releaseRuns()) {
    const old = oldCleanupRan(run);
    const now = decide(run);
    if (old !== now) mismatches++;
    const live =
      run.github.event_name === "workflow_dispatch" && run.inputs.dry_run
        ? "dry"
        : "real";
    const key = [
      run.needs.build.result,
      run.needs.build.outputs.mode || "none",
      live,
      ...["build-kotlin", ...Object.keys(OLD_CLEANUP_IF)].map(
        (j) => run.needs[j].result,
      ),
    ].join(" ");
    const row = rows.get(key);
    if (row && (row.old !== old || row.now !== now))
      throw new Error(`${key}: decision depends on more than lane results`);
    rows.set(key, { old, now, n: (row?.n ?? 0) + 1 });
  }
  return { rows, mismatches };
}

test("cleanup-release-next runs exactly when the old per-lane cleanup did", (t) => {
  const job = publishWorkflow.jobs["cleanup-release-next"];
  const { rows, mismatches } = decisionTable((run) =>
    job
      ? stepCondition(job.if, { ...run, status: jobStatus(run.needs) })
      : false,
  );
  const lines = [...rows].map(
    ([k, v]) => `${k} | old=${v.old} new=${v.now} n=${v.n}`,
  );
  for (const line of lines) t.diagnostic(line);
  assert.ok(job, "missing cleanup-release-next job");
  assert.equal(mismatches, 0, "decisions differ");
  const runsCleanup = [...rows.values()].filter((v) => v.old);
  assert.ok(runsCleanup.length >= 4, "the cleanup runs in some states");
});

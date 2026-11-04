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
test("earlier cleanup waits for no pending Kotlin and remote failures are not ignored", () => {
  for (const lane of ["publish", "publish-dotnet", "publish-maven"]) {
    const block = job(lane)
      .split("- name: Delete release/next if present")[1]
      .split("- name:")[0];
    const expr = condition(block, 8);
    const pending = state();
    pending.build.outputs.dotnet_count = "0";
    pending.build.outputs.java_count = "0";
    assert.equal(evaluate(expr, pending), false);
    pending.build.outputs.kotlin_count = "0";
    assert.equal(evaluate(expr, pending), true);
    pending["build-kotlin"].result = "failure";
    assert.equal(evaluate(expr, pending), false);
    pending["build-kotlin"].result = "skipped";
    pending.build.outputs.kotlin_count = "0";
    assert.equal(evaluate(expr, pending), true);
    assert.match(block, /git ls-remote/);
    assert.doesNotMatch(block, /\|\| echo/);
  }
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
test("verified outputs follow ordinary record helpers and cleanup", () => {
  const publish = job("publish-kotlin");
  assert.ok(
    publish.indexOf("Verify published Kotlin POMs") <
      publish.indexOf("create-tags.sh"),
  );
  assert.ok(
    publish.indexOf("reconcile-release.sh") <
      publish.indexOf('echo "published_packages='),
  );
  assert.ok(
    publish.indexOf('echo "published_packages=') <
      publish.indexOf("Delete release/next"),
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
const CLEANUP_LANES = [
  "publish",
  "publish-dotnet",
  "publish-maven",
  "publish-kotlin",
];
const MINT = "Mint devops-bot token for release/next cleanup";
const DELETE = "Delete release/next if present";
const WARN = "Warn if release/next was left behind";

// Runs a lane's mint, delete and warning steps as the runner would: the mint
// yields a token naming its permissions (or fails with none), the delete's
// env is rendered from the workflow, and a fake `git` records each call with
// the credential it sent. `push: "error"` makes the delete push fail.
function runReleaseNextCleanup(
  lane: string,
  needs: any,
  {
    exists = true,
    mintFails = false,
    push = "ok",
  }: { exists?: boolean; mintFails?: boolean; push?: "ok" | "error" } = {},
) {
  const job = publishWorkflow.jobs[lane];
  const steps = job.steps;
  const mint = stepNamed(job, MINT);
  const del = stepNamed(job, DELETE);
  const warn = stepNamed(job, WARN);
  assert.ok(steps.indexOf(mint) < steps.indexOf(del), `${lane}: mint first`);
  assert.ok(steps.indexOf(del) < steps.indexOf(warn), `${lane}: warn last`);
  const bin = mkdtempSync(join(tmpdir(), "release-next-"));
  try {
    const log = join(bin, "git.log");
    writeFileSync(log, "");
    writeFileSync(
      join(bin, "git"),
      `#!${process.execPath}
const args = process.argv.slice(2);
require("node:fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
if (args[0] === "ls-remote")
  process.stdout.write(${exists} ? "abc\\trefs/heads/release/next\\n" : "");
if (args.includes("push") && ${JSON.stringify(push)} === "error") {
  process.stderr.write("remote: Permission denied\\n");
  process.exit(1);
}
process.exit(0);
`,
    );
    chmodSync(join(bin, "git"), 0o755);
    const run = runJob(
      publishWorkflow,
      { ...job, steps: [mint, del, warn] },
      {
        needs,
        github: { repository: "o/r", token: "job:contents=read" },
        secrets: { DEVOPS_BOT_PRIVATE_KEY: "pem" },
      },
      // The lane's job if, needs and environment are pinned by the lane
      // tests above; this runs its steps as if the job started.
      { bin, mintFails: () => mintFails, jobConditionEvaluatedByCaller: true },
    );
    const calls = readFileSync(log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as string[]);
    return { run, calls, mint, del };
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
}

function pushCredential(args: string[]): string | undefined {
  const header = args[0] === "-c" ? args[1] : "";
  const m = header.match(
    /^http\.https:\/\/github\.com\/\.extraheader=AUTHORIZATION: basic (.+)$/,
  );
  return m ? Buffer.from(m[1], "base64").toString() : undefined;
}

// A state in which every lane's release/next cleanup applies.
function idleState(): any {
  const idle = state("skipped", "stable", "0");
  idle.build.outputs.dotnet_count = "0";
  idle.build.outputs.java_count = "0";
  return idle;
}

test("release/next cleanup deletes as the devops-bot app with a contents-only token", () => {
  for (const lane of CLEANUP_LANES) {
    const { run, calls, mint } = runReleaseNextCleanup(lane, idleState());
    assert.equal(mint.uses, APP_TOKEN_ACTION, lane);
    // A timeout or any other key would change when the delete gets a token.
    // continue-on-error is allowed only because the delete is guarded on the
    // mint's outcome (asserted below).
    for (const key of Object.keys(mint))
      assert.ok(
        ["name", "id", "if", "uses", "with", "continue-on-error"].includes(key),
        `${lane}: unexpected ${key} on the mint step`,
      );
    assert.deepEqual(mint.with, {
      "client-id": "Iv23liBNyieHVFKABrJ3",
      "private-key": "${{ secrets.DEVOPS_BOT_PRIVATE_KEY }}",
      "permission-contents": "write",
    });
    assert.equal(run.status, "success", lane);
    assert.equal(run.log[0].ran, true, `${lane}: mint ran`);
    assert.equal(run.log[1].ran, true, `${lane}: delete ran`);
    assert.equal(run.log[2].ran, false, `${lane}: no warning`);
    const pushes = calls.filter((c) => c.includes("push"));
    assert.equal(pushes.length, 1, `${lane}: one delete push`);
    assert.deepEqual(pushes[0].slice(2), [
      "push",
      "origin",
      "--delete",
      "release/next",
    ]);
    assert.equal(
      pushCredential(pushes[0]),
      `x-access-token:${appToken(mint)}`,
      `${lane}: the push authenticates with the minted token`,
    );
    assert.equal(appToken(mint), "app:contents=write");
    // Nothing to delete: no push.
    const none = runReleaseNextCleanup(lane, idleState(), { exists: false });
    assert.equal(none.calls.filter((c) => c.includes("push")).length, 0);
  }
});

test("release/next delete runs exactly when its mint ran and minted a token", () => {
  const states: any[] = [];
  for (const kotlin of ["success", "skipped", "failure"])
    for (const mode of ["stable", "prerelease"])
      for (const count of ["0", "2"])
        for (const other of ["0", "1"]) {
          const s = state(kotlin, mode, count);
          s.build.outputs.dotnet_count = other;
          s.build.outputs.java_count = other;
          states.push(s);
        }
  for (const lane of CLEANUP_LANES) {
    const job = publishWorkflow.jobs[lane];
    const mint = stepNamed(job, MINT);
    const del = stepNamed(job, DELETE);
    let runs = 0;
    for (const needs of states) {
      const ctx = { needs, inputs: {}, github: {} };
      const minted = stepCondition(mint.if, ctx);
      for (const outcome of ["success", "failure"]) {
        const steps = {
          [mint.id]: { outcome: minted ? outcome : "skipped" },
        };
        assert.equal(
          stepCondition(del.if, { ...ctx, steps }),
          minted && outcome === "success",
          `${lane}: mint ${minted ? outcome : "skipped"}`,
        );
      }
      if (minted) runs++;
    }
    assert.ok(runs > 0, `${lane}: the cleanup runs in some state`);
  }
});

// The packages are already published when the cleanup runs: a GitHub App
// outage, a key rotation or a failed push must not turn a shipped release red,
// and must say that release/next was left behind.
test("release/next cleanup cannot fail a lane after its packages are published", () => {
  for (const lane of CLEANUP_LANES) {
    const { del } = runReleaseNextCleanup(lane, idleState());
    assert.equal(del.id, "release-next-delete", `${lane}: delete id`);

    const noToken = runReleaseNextCleanup(lane, idleState(), {
      mintFails: true,
    });
    assert.equal(noToken.run.status, "success", `${lane}: mint failure`);
    assert.equal(noToken.run.steps["release-next-token"].outcome, "failure");
    assert.equal(noToken.run.log[1].ran, false, `${lane}: no delete`);
    assert.equal(noToken.calls.length, 0, `${lane}: git never called`);
    assert.equal(noToken.run.log[2].ran, true, `${lane}: warning`);
    assert.match(
      noToken.run.log[2].stdout,
      /^::warning[^\n]*release\/next[^\n]*left behind/m,
    );

    const failedPush = runReleaseNextCleanup(lane, idleState(), {
      push: "error",
    });
    assert.equal(failedPush.run.status, "success", `${lane}: push failure`);
    assert.equal(
      failedPush.run.steps["release-next-delete"].outcome,
      "failure",
    );
    assert.equal(failedPush.run.log[2].ran, true, `${lane}: warning`);
    assert.match(
      failedPush.run.log[2].stdout,
      /^::warning[^\n]*release\/next[^\n]*left behind/m,
    );
  }
});

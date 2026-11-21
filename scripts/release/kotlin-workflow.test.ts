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
      `return (${expression});`,
    )(
      needs,
      { event_name: "workflow_dispatch" },
      { mode, dry_run: dry },
      () => true,
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

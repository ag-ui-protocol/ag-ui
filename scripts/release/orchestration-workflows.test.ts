import test from "node:test";
import assert from "node:assert/strict";
import {
  readFileSync,
  mkdtempSync,
  writeFileSync,
  chmodSync,
  rmSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

// No YAML parser is installed in the root, so steps are cut out of the text by
// their `- name:` line, like kotlin-workflow.test.ts does for jobs.
const canary = readFileSync(".github/workflows/canary.yml", "utf8");
const prepare = readFileSync(".github/workflows/prepare-release.yml", "utf8");

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

test("create-release-pr binds no deployment environment", () => {
  const job = prepare.split(/^  create-release-pr:\n/m)[1];
  assert.ok(job, "missing create-release-pr job");
  assert.doesNotMatch(job.split(/^ {4}steps:/m)[0], /^ {4}environment:/m);
});

test("canary waits long enough for an approval, with a token that lasts", () => {
  const timeout = Number(canary.match(/^ {4}timeout-minutes: (\d+)$/m)?.[1]);
  const wait = step(canary, "Wait for the publish run");
  const waitTimeout = Number(field(wait, "timeout-minutes"));
  assert.equal(timeout, 180, "job timeout is the agreed 180 minutes");
  assert.ok(waitTimeout > 60, "wait must outlast the one-hour app token");
  assert.ok(timeout >= waitTimeout + 15, "job timeout leaves room for cleanup");
  assert.match(wait, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(wait, /gh run watch .*--exit-status --interval 60/);
  assert.match(canary, /^ {6}actions: read/m);
});

test("canary cleanup mints a fresh, contents-only devops-bot token", () => {
  const mint = step(canary, "Mint devops-bot token for canary cleanup");
  const del = step(canary, "Delete canary ref");
  assert.match(
    mint,
    /uses: actions\/create-github-app-token@64ab729a6294000f5aa4a4bc0b73d1f32bc45510/,
  );
  assert.match(mint, /app-id: "3877599"/);
  assert.deepEqual(mint.match(/permission-[a-z-]+: \w+/g), [
    "permission-contents: write",
  ]);
  assert.equal(field(mint, "if"), field(del, "if"));
  assert.match(
    del,
    /GH_TOKEN: \$\{\{ steps\.cleanup-token\.outputs\.token \}\}/,
  );
  assert.ok(
    canary.indexOf("- name: Wait for the publish run") <
      canary.indexOf("- name: Mint devops-bot token for canary cleanup"),
  );
});

// Runs the real cleanup script with a fake `gh` that reports `status` for the
// publish run and logs every call.
function runCleanup(status: string | null): { log: string; out: string } {
  const root = mkdtempSync(join(tmpdir(), "canary-cleanup-"));
  try {
    const log = join(root, "gh.log");
    const gh = join(root, "gh");
    writeFileSync(
      gh,
      [
        "#!/bin/bash",
        `printf '%s\\n' "$*" >> '${log}'`,
        'if [ "$1 $2" = "run view" ]; then',
        status === null ? "  exit 1" : `  echo '${status}'; exit 0`,
        "fi",
        "exit 0",
        "",
      ].join("\n"),
    );
    chmodSync(gh, 0o755);
    const file = join(root, "cleanup.sh");
    writeFileSync(file, script(step(canary, "Delete canary ref")));
    const r = spawnSync("bash", [file], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${root}:${process.env.PATH}`,
        GH_TOKEN: "fake",
        STATUS_TOKEN: "fake",
        BRANCH: "canary/x-1-1",
        RUN_ID: "42",
        GITHUB_REPOSITORY: "o/r",
      },
    });
    assert.equal(r.status, 0, r.stderr);
    let calls = "";
    try {
      calls = readFileSync(log, "utf8");
    } catch {}
    return { log: calls, out: r.stdout + r.stderr };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

for (const status of ["waiting", "queued", "in_progress", "pending", null]) {
  test(`canary cleanup keeps the ref while the publish run is ${status ?? "unreadable"}`, () => {
    const { log, out } = runCleanup(status);
    assert.doesNotMatch(log, /-X DELETE/);
    assert.match(out, /Leaving canary\/x-1-1 in place/);
  });
}

test("canary cleanup deletes the ref once the publish run completed", () => {
  const { log } = runCleanup("completed");
  assert.match(
    log,
    /api --silent -X DELETE repos\/o\/r\/git\/refs\/heads\/canary\/x-1-1/,
  );
});

test("publish-release keeps stable and prerelease runs in separate concurrency groups", () => {
  const publish = readFileSync(".github/workflows/publish-release.yml", "utf8");
  const blocks = publish.match(/^concurrency:\n(?: .*\n)+/gm) ?? [];
  assert.equal(
    blocks.length,
    1,
    "expected one workflow-level concurrency block",
  );
  // Push events (inputs.mode is empty) and mode=stable dispatches keep the
  // unchanged `release-publish` group; each prerelease ref gets its own group.
  assert.match(
    blocks[0],
    /^ {2}group: \$\{\{ inputs\.mode == 'prerelease' && format\('release-publish-prerelease-\{0\}', github\.ref\) \|\| 'release-publish' \}\}$/m,
  );
  assert.match(blocks[0], /^ {2}cancel-in-progress: false$/m);
  // Stable publishes are never cancelled in progress, and no job overrides this.
  assert.doesNotMatch(publish, /cancel-in-progress: true/);
  assert.doesNotMatch(publish, /^ {4}concurrency:/m);
});

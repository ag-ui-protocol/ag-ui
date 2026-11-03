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

const publish = readFileSync(".github/workflows/publish-release.yml", "utf8");

// Minimal evaluator for the GitHub expression subset used by the workflow-level
// concurrency group: dotted context lookups, '...' strings, ==, !=, &&, ||,
// parentheses and format(). && / || return an operand, like GitHub does.
function evalExpr(src: string, ctx: Record<string, string>): string {
  const toks = src.match(/'[^']*'|==|!=|&&|\|\||[(),]|[A-Za-z_][\w.]*/g) ?? [];
  let i = 0;
  const peek = () => toks[i];
  const take = (t?: string) => {
    const v = toks[i++];
    if (t !== undefined) assert.equal(v, t, `expected '${t}' in ${src}`);
    return v;
  };
  function primary(): string {
    const t = take();
    if (t === "(") {
      const v = or();
      take(")");
      return v;
    }
    if (t.startsWith("'")) return t.slice(1, -1);
    if (t === "format") {
      take("(");
      const args = [or()];
      while (peek() === ",") {
        take(",");
        args.push(or());
      }
      take(")");
      return args[0].replace(/\{(\d+)\}/g, (_, n) => args[Number(n) + 1]);
    }
    assert.ok(t in ctx, `unknown context '${t}'`);
    return ctx[t];
  }
  function cmp(): string {
    let v = primary();
    while (peek() === "==" || peek() === "!=") {
      const op = take();
      const r = primary();
      v = (op === "==") === (v === r) ? "true" : "";
    }
    return v;
  }
  function and(): string {
    let v = cmp();
    while (peek() === "&&") {
      take();
      const r = cmp();
      v = v ? r : v;
    }
    return v;
  }
  function or(): string {
    let v = and();
    while (peek() === "||") {
      take();
      const r = and();
      v = v ? v : r;
    }
    return v;
  }
  const v = or();
  assert.equal(i, toks.length, `trailing tokens in ${src}`);
  return v;
}

function concurrencyBlock(): string {
  const blocks = publish.match(/^concurrency:\n(?: .*\n)+/gm) ?? [];
  assert.equal(
    blocks.length,
    1,
    "expected one workflow-level concurrency block",
  );
  return blocks[0];
}

function groupFor(mode: string, ref: string): string {
  const expr = concurrencyBlock().match(/^ {2}group: \$\{\{ (.*) \}\}$/m)?.[1];
  assert.ok(expr, "concurrency group is not a single expression");
  return evalExpr(expr, { "inputs.mode": mode, "github.ref": ref });
}

test("publish-release concurrency never cancels and no job overrides it", () => {
  assert.match(concurrencyBlock(), /^ {2}cancel-in-progress: false$/m);
  assert.doesNotMatch(publish, /cancel-in-progress: true/);
  assert.doesNotMatch(publish, /^ {4}concurrency:/m);
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
  const block = canary.match(/^concurrency:\n((?: {2}.*\n|\n)*)/m)?.[1];
  if (block === undefined) return;
  const group = block.match(/^ {2}group: (.*)$/m)?.[1];
  assert.ok(group, "a concurrency block must name its group");
  assert.match(
    group,
    /\$\{\{[^}]*github\.run_id[^}]*\}\}/,
    "a shared group keeps only one pending canary; key it on github.run_id",
  );
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
      script(step(publish, "Compute prerelease version and bump")).replaceAll(
        "/tmp/bump-result.json",
        join(root, "bump-result.json"),
      ),
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

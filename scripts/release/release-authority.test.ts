// Release-authority guards in .github/workflows/publish-release.yml.
//
// These tests execute the REAL inline shell of the guard and canary-validation
// steps (extracted from the workflow, not copied) against local fixtures:
// refs a writer could dispatch on, and tarballs / Python distributions a
// branch-controlled build could hand to the OIDC-bearing publish job. Nothing
// here talks to GitHub, npm or PyPI.
//
// Scope note: these guards are defense in depth for an UNMODIFIED workflow.
// A modified copy of publish-release.yml on a dispatchable ref is bounded only
// by the `npm` environment's protection rules — see the workflow header.

import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";

const workflow = readFileSync(".github/workflows/publish-release.yml", "utf8");

// No YAML parser is installed at the root (see kotlin-workflow.test.ts), so
// bound extraction by indentation.
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

function stepNames(jobBlock: string): string[] {
  return [...jobBlock.matchAll(/^ {6}- name: (.*)$/gm)].map((m) => m[1]);
}

function step(jobBlock: string, name: string): string {
  const lines = jobBlock.split("\n");
  const start = lines.findIndex((l) => l === `      - name: ${name}`);
  assert.ok(start >= 0, `missing step ${name}`);
  let end = start + 1;
  while (
    end < lines.length &&
    !/^ {6}- /.test(lines[end]) &&
    !/^ {6}#/.test(lines[end])
  )
    end++;
  return lines.slice(start, end).join("\n");
}

function stepIf(stepBlock: string): string {
  return stepBlock.match(/^ {8}if: (.*)$/m)?.[1] ?? "";
}

function runScript(stepBlock: string): string {
  const lines = stepBlock.split("\n");
  const at = lines.findIndex((l) => l === "        run: |");
  assert.ok(at >= 0, "step has no `run: |` block");
  const body: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (line.trim() !== "" && !line.startsWith("          ")) break;
    body.push(line.slice(10));
  }
  return body.join("\n");
}

function bash(script: string, env: Record<string, string>, cwd?: string) {
  const res = spawnSync("bash", ["-c", script], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
    cwd,
    encoding: "utf8",
  });
  return { code: res.status, out: `${res.stdout}${res.stderr}` };
}

// A job "can run in prerelease mode" unless its `if:` pins it to stable.
function prereleaseReachable(stepBlock: string): boolean {
  const cond = stepIf(stepBlock);
  return !(
    cond.includes("mode == 'stable'") || cond.includes("mode != 'prerelease'")
  );
}

// ---------------------------------------------------------------- ref guard

const GUARD_JOBS = ["build", "publish", "publish-dotnet"];

test("every registry-capable job starts with the same inline ref guard", () => {
  const scripts = GUARD_JOBS.map((name) => {
    const block = job(name);
    assert.equal(stepNames(block)[0], "Guard release ref", `${name}: guard must be first`);
    const guard = step(block, "Guard release ref");
    assert.equal(stepIf(guard), "", `${name}: guard must be unconditional`);
    assert.doesNotMatch(guard, /uses:/, `${name}: guard must be inline, not an action`);
    if (name === "build") assert.doesNotMatch(guard, /^ +BUILD_MODE: /m);
    else assert.match(guard, /^ +BUILD_MODE: \$\{\{ needs\.build\.outputs\.mode \}\}$/m);
    return runScript(guard);
  });
  assert.equal(scripts[1], scripts[0], "publish guard drifted from build guard");
  assert.equal(scripts[2], scripts[0], "publish-dotnet guard drifted from build guard");
});

test("ref guard accepts only main (stable/canary) and canary/<slug> (canary)", () => {
  const guard = runScript(step(job("publish"), "Guard release ref"));
  const cases: Array<[string, string, string, string, boolean]> = [
    // event, ref, inputs.mode, build mode, allowed
    ["push", "refs/heads/main", "", "stable", true],
    ["push", "refs/heads/main", "", "", true],
    ["workflow_dispatch", "refs/heads/main", "stable", "stable", true],
    ["workflow_dispatch", "refs/heads/main", "prerelease", "prerelease", true],
    ["workflow_dispatch", "refs/heads/canary/perf-x-38938972622-1", "prerelease", "prerelease", true],
    // Stable from anything but main — including the env-admitted ref families.
    ["workflow_dispatch", "refs/heads/canary/x", "stable", "stable", false],
    ["workflow_dispatch", "refs/heads/release/next", "stable", "stable", false],
    ["push", "refs/heads/feature", "", "stable", false],
    // Prerelease from refs the `npm` environment currently admits but no
    // release flow uses, or from refs it does not admit at all.
    ["workflow_dispatch", "refs/heads/release/next", "prerelease", "prerelease", false],
    ["workflow_dispatch", "refs/heads/prerelease/x", "prerelease", "prerelease", false],
    ["workflow_dispatch", "refs/heads/perf/client-copy-on-write-apply", "prerelease", "prerelease", false],
    ["workflow_dispatch", "refs/tags/v1.0.0", "prerelease", "prerelease", false],
    ["workflow_dispatch", "refs/heads/canary/", "prerelease", "prerelease", false],
    ["workflow_dispatch", "refs/heads/canary/a/b", "prerelease", "prerelease", false],
    ["workflow_dispatch", "refs/heads/xcanary/a", "prerelease", "prerelease", false],
    ["workflow_dispatch", "refs/heads/main-evil", "stable", "stable", false],
    ["workflow_dispatch", "refs/heads/canary/a\nrefs/heads/main", "prerelease", "prerelease", false],
    // Unknown modes/events, and a build job reporting a different mode.
    ["workflow_dispatch", "refs/heads/main", "latest", "latest", false],
    ["push", "refs/heads/main", "prerelease", "prerelease", false],
    ["repository_dispatch", "refs/heads/main", "", "stable", false],
    ["workflow_dispatch", "refs/heads/canary/x", "prerelease", "stable", false],
    ["workflow_dispatch", "refs/heads/main", "stable", "prerelease", false],
  ];
  for (const [event, ref, mode, buildMode, allowed] of cases) {
    const env: Record<string, string> = { EVENT_NAME: event, RELEASE_REF: ref, INPUT_MODE: mode };
    if (buildMode) env.BUILD_MODE = buildMode;
    const res = bash(guard, env);
    assert.equal(res.code === 0, allowed, `${event} ${JSON.stringify(ref)} mode=${mode} build=${buildMode}: ${res.out}`);
  }
});

// ------------------------------------------- prerelease publish job: no repo code

test("prerelease publish job runs no branch-controlled code", () => {
  const publish = job("publish");
  assert.match(publish, /^ {4}environment: npm$/m);
  assert.match(publish, /id-token: write/);
  assert.match(
    publish,
    /ref: \$\{\{ needs\.build\.outputs\.mode == 'prerelease' && 'refs\/heads\/main' \|\| needs\.build\.outputs\.source_sha \}\}/,
  );
  const forbidden =
    /pnpm |pnpm\/action-setup|node scripts\/|tsx |bash scripts\/|python3? scripts\/|npm (?:install|ci|run|pack)\b|ts-canary-artifacts/;
  for (const name of stepNames(publish)) {
    const block = step(publish, name);
    if (!prereleaseReachable(block)) continue;
    // Comments and jq-rendered summary text (e.g. "npm install X@canary"
    // shown to the reader) are not executed.
    const executed = block
      .split("\n")
      .filter((l) => !/^\s*#/.test(l) && !/\bjq -r\b/.test(l))
      .join("\n");
    assert.doesNotMatch(executed, forbidden, `prerelease-reachable step "${name}" runs repository code`);
  }
});

test("canary payloads are validated before any registry upload", () => {
  const publish = job("publish");
  const names = stepNames(publish);
  const order = (n: string) => {
    const i = names.indexOf(n);
    assert.ok(i >= 0, `missing step ${n}`);
    return i;
  };
  assert.ok(order("Validate canary tarballs (prerelease)") < order("Publish TypeScript canary (prerelease)"));
  assert.ok(
    order("Validate Python canary distributions (prerelease)") < order("Publish Python canary (prerelease)"),
  );

  const npmPublish = step(publish, "Publish TypeScript canary (prerelease)");
  assert.match(npmPublish, /done < <\(jq -c '\.\[\]' "\$MANIFEST"\)/);
  assert.match(npmPublish, /cd "\$PUBLISH_CWD" && npx --yes npm@11\.15\.0 publish "\$TARBALL"/);
  for (const flag of ["--tag canary", "--ignore-scripts", "--registry=https://registry.npmjs.org/", "--provenance"])
    assert.ok(npmPublish.includes(flag), `npm canary publish lacks ${flag}`);
  assert.doesNotMatch(npmPublish, /pre_ts_packages_json|pre_ts_projects/);

  const uvPublish = step(publish, "Publish Python canary (prerelease)");
  assert.match(uvPublish, /done < <\(jq -c '\.\[\]' "\$MANIFEST"\)/);
  for (const flag of ["--no-config", "--trusted-publishing always", "--publish-url https://upload.pypi.org/legacy/"])
    assert.ok(uvPublish.includes(flag), `uv canary publish lacks ${flag}`);
  assert.doesNotMatch(uvPublish, /bump-result/);

  // The scope that selects main's allowlist comes from the run's own input.
  for (const v of ["Validate canary tarballs (prerelease)", "Validate Python canary distributions (prerelease)"])
    assert.match(step(publish, v), /SCOPE: \$\{\{ inputs\.scope \}\}/);
});

test("build job packs canary tarballs and ships only tarballs", () => {
  const build = job("build");
  const names = stepNames(build);
  const pack = names.indexOf("Pack TypeScript canary tarballs (prerelease)");
  const upload = names.indexOf("Upload TypeScript canary tarballs (prerelease)");
  assert.ok(pack > names.indexOf("Test TypeScript packages in scope (prerelease)"));
  assert.ok(upload > pack);
  assert.match(step(build, "Pack TypeScript canary tarballs (prerelease)"), /node scripts\/package-licenses\/check\.mjs archive/);
  assert.match(step(build, "Upload TypeScript canary tarballs (prerelease)"), /path: \$\{\{ runner\.temp \}\}\/canary-tarballs\/\*\.tgz/);
  assert.doesNotMatch(build, /ts-canary-artifacts/);
  assert.doesNotMatch(build, /^ {4}environment:|^ +id-token: write/m);
});

// ------------------------------------------------ fixtures shared by validators

const CONFIG = {
  scopes: {
    "demo-ts": {
      packages: [
        { name: "@ag-ui/core", path: "sdks/typescript/packages/core", ecosystem: "typescript" },
        { name: "@ag-ui/client", path: "sdks/typescript/packages/client", ecosystem: "typescript" },
      ],
    },
    "demo-py": {
      packages: [{ name: "ag-ui-protocol", path: "sdks/python", ecosystem: "python" }],
    },
    "demo-mixed": {
      packages: [
        { name: "@ag-ui/langgraph", path: "integrations/langgraph/typescript", ecosystem: "typescript" },
        { name: "ag-ui-langgraph", path: "integrations/langgraph/python", ecosystem: "python" },
      ],
    },
  },
};

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "release-authority-"));
  writeFileSync(join(root, "release.config.json"), JSON.stringify(CONFIG));
  return root;
}

function tarball(dir: string, file: string, ...manifests: object[]): string {
  const stage = mkdtempSync(join(tmpdir(), "release-authority-pkg-"));
  mkdirSync(join(stage, "package"));
  writeFileSync(join(stage, "package", "index.js"), "module.exports = 1;\n");
  const out = join(dir, file);
  const tarPath = join(stage, "pkg.tar");
  const [first, ...rest] = manifests;
  writeFileSync(join(stage, "package", "package.json"), JSON.stringify(first));
  let r = spawnSync("tar", ["-cf", tarPath, "-C", stage, "package"]);
  assert.equal(r.status, 0, String(r.stderr));
  for (const extra of rest) {
    // Append a second package/package.json entry (duplicate member).
    writeFileSync(join(stage, "package", "package.json"), JSON.stringify(extra));
    r = spawnSync("tar", ["-rf", tarPath, "-C", stage, "package/package.json"]);
    assert.equal(r.status, 0, String(r.stderr));
  }
  r = spawnSync("bash", ["-c", 'gzip -c "$1" > "$2"', "_", tarPath, out]);
  assert.equal(r.status, 0, String(r.stderr));
  rmSync(stage, { recursive: true, force: true });
  return out;
}

const tgzName = (name: string, version: string) =>
  `${name.replace(/^@/, "").replace("/", "-")}-${version}.tgz`;

// ------------------------------------------------ TypeScript tarball validation

const tsValidate = runScript(step(job("publish"), "Validate canary tarballs (prerelease)"));

type Pkg = { name: string; version: string; publishConfig?: object };

function runTs(opts: {
  tarballs: Pkg[];
  expected?: Array<{ name: string; version: string }>;
  scope?: string;
  mutate?: (dir: string) => void;
}) {
  const root = fixtureRoot();
  const dir = join(root, "canary-tarballs");
  mkdirSync(dir);
  for (const p of opts.tarballs) tarball(dir, tgzName(p.name, p.version), p);
  opts.mutate?.(dir);
  const expected = opts.expected ?? opts.tarballs.map(({ name, version }) => ({ name, version, path: "x" }));
  const res = bash(tsValidate, {
    SCOPE: opts.scope ?? "demo-ts",
    EXPECTED_PACKAGES: JSON.stringify(expected),
    TARBALL_DIR: dir,
    RELEASE_CONFIG: join(root, "release.config.json"),
    MANIFEST: join(root, "manifest.json"),
  });
  let manifest: unknown = null;
  if (res.code === 0) manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
  rmSync(root, { recursive: true, force: true });
  return { ...res, manifest };
}

const core = { name: "@ag-ui/core", version: "0.0.53-canary.fix-user-issue.0", publishConfig: { access: "public" } };
const client = { name: "@ag-ui/client", version: "0.0.53-canary.fix-user-issue.0" };

test("canary tarball validation accepts a well-formed in-scope canary set", () => {
  const res = runTs({ tarballs: [core, client] });
  assert.equal(res.code, 0, res.out);
  assert.deepEqual(
    (res.manifest as Pkg[]).map((p) => p.name).sort(),
    ["@ag-ui/client", "@ag-ui/core"],
  );
});

test("canary tarball validation rejects payloads outside the canary channel", () => {
  const reject = (label: string, opts: Parameters<typeof runTs>[0], why: RegExp) => {
    const res = runTs(opts);
    assert.notEqual(res.code, 0, `${label} was accepted`);
    assert.match(res.out, why, label);
  };
  // Version shapes that would satisfy ordinary ranges or are not canaries.
  for (const version of ["99.0.0", "0.0.54", "1.0.0-alpha.0", "1.0.0-rc.1", "1.0.0-canary", "1.0.0-canary.x+build", "v1.0.0-canary.x.0", "01.0.0-canary.x.0"])
    reject(`version ${version}`, { tarballs: [{ ...core, version }] }, /is not X\.Y\.Z-canary/);
  // Packages that exist on npm under @ag-ui but are not in the dispatched scope
  // of MAIN's config (the build job cannot widen the scope).
  reject("out-of-scope package", { tarballs: [{ ...core, name: "@ag-ui/proto" }] }, /not a TypeScript package of scope/);
  reject("unscoped lookalike", { tarballs: [{ ...core, name: "ag-ui-core" }] }, /not a TypeScript package of scope/);
  reject("unknown scope", { tarballs: [core], scope: "no-such-scope" }, /has no TypeScript packages/);
  reject("python-only scope", { tarballs: [core], scope: "demo-py" }, /has no TypeScript packages/);
  // Tag / registry overrides smuggled through package.json.
  reject("publishConfig.tag", { tarballs: [{ ...core, publishConfig: { access: "public", tag: "latest" } }] }, /publishConfig/);
  reject("publishConfig.registry", { tarballs: [{ ...core, publishConfig: { registry: "https://evil.example/" } }] }, /publishConfig/);
  reject("restricted access", { tarballs: [{ ...core, publishConfig: { access: "restricted" } }] }, /publishConfig/);
  reject("publishConfig not object", { tarballs: [{ ...core, publishConfig: "latest" as unknown as object }] }, /publishConfig/);
  // Set mismatches between what the build job announced and what it shipped.
  reject("extra tarball", { tarballs: [core, client], expected: [core] }, /do not match/);
  reject("missing tarball", { tarballs: [core], expected: [core, client] }, /do not match/);
  reject("version drift", { tarballs: [core], expected: [{ ...core, version: "0.0.53-canary.other.0" }] }, /do not match/);
  reject("empty artifact", { tarballs: [], expected: [core] }, /no tarballs/);
  // File-level tampering.
  reject(
    "renamed tarball",
    { tarballs: [core], mutate: (d) => spawnSync("mv", [join(d, tgzName(core.name, core.version)), join(d, "ag-ui-core-1.0.0.tgz")]) },
    /expected file name/,
  );
  reject(
    "non-tarball file",
    { tarballs: [core], mutate: (d) => writeFileSync(join(d, "notes.txt"), "x") },
    /is not a \.tgz/,
  );
  reject(
    "dotfile",
    { tarballs: [core], mutate: (d) => writeFileSync(join(d, ".npmrc"), "registry=https://evil.example/") },
    /is not a \.tgz/,
  );
  reject(
    "symlinked tarball",
    { tarballs: [core], mutate: (d) => symlinkSync("/etc/hosts", join(d, tgzName(client.name, client.version))) },
    /not a regular file/,
  );
  reject(
    "tarball without package.json",
    { tarballs: [core], mutate: (d) => writeFileSync(join(d, tgzName(client.name, client.version)), "") },
    /no package\/package\.json|must contain exactly one/,
  );
  reject(
    "duplicate package.json members",
    {
      tarballs: [],
      expected: [core],
      mutate: (d) => tarball(d, tgzName(core.name, core.version), core, { ...core, version: "99.0.0" }),
    },
    /exactly one package\/package\.json/,
  );
});

// ------------------------------------------------ Python distribution validation

const pyValidate = runScript(step(job("publish"), "Validate Python canary distributions (prerelease)"));

// Real wheel / sdist archives built offline by the runner's python3. The
// embedded identity defaults to the one in the file name; `meta*` override it
// to model a renamed artifact, and `shape` produces malformed archives.
type DistSpec =
  | string
  | {
      file: string;
      metaName?: string;
      metaVersion?: string;
      dirName?: string;
      shape?: "dup-member" | "no-metadata" | "two-names" | "extra-top" | "pkginfo-symlink" | "corrupt";
      extraHeaders?: string; // e.g. Requires-Dist lines
    };

const DIST_BUILDER = String.raw`
import io, json, sys, tarfile, zipfile
spec = json.loads(sys.argv[1])
path, name, version = spec["path"], spec["metaName"], spec["metaVersion"]
dirname, shape = spec["dirName"], spec.get("shape")
headers = f"Metadata-Version: 2.1\nName: {name}\nVersion: {version}\n" + spec.get("extraHeaders", "")
if shape == "two-names":
    headers += "Name: requests\n"
meta = (headers + "\n").encode()
if shape == "corrupt":
    open(path, "wb").write(b"not an archive")
elif path.endswith(".whl"):
    with zipfile.ZipFile(path, "w") as z:
        di = dirname + ".dist-info"
        if shape != "no-metadata":
            z.writestr(di + "/METADATA", meta)
        if shape == "dup-member":
            z.writestr(di + "/METADATA", meta.replace(version.encode(), b"99.0.0"))
        z.writestr(di + "/WHEEL", "Wheel-Version: 1.0\nRoot-Is-Purelib: true\nTag: py3-none-any\n")
        z.writestr(di + "/RECORD", "")
else:
    with tarfile.open(path, "w:gz") as t:
        def add(member, data):
            ti = tarfile.TarInfo(member)
            ti.size = len(data)
            t.addfile(ti, io.BytesIO(data))
        if shape == "pkginfo-symlink":
            ti = tarfile.TarInfo(dirname + "/PKG-INFO")
            ti.type, ti.linkname = tarfile.SYMTYPE, "/etc/hosts"
            t.addfile(ti)
        elif shape != "no-metadata":
            add(dirname + "/PKG-INFO", meta)
        if shape == "dup-member":
            add(dirname + "/PKG-INFO", meta.replace(version.encode(), b"99.0.0"))
        if shape == "extra-top":
            add("other-1.0/PKG-INFO", meta)
        add(dirname + "/setup.py", b"")
`;

function writeDist(dir: string, spec: DistSpec) {
  const s = typeof spec === "string" ? { file: spec } : spec;
  let fileName: string, fileVersion: string;
  if (s.file.endsWith(".whl")) {
    [fileName, fileVersion] = s.file.slice(0, -4).split("-");
  } else {
    const stem = s.file.replace(/\.tar\.gz$/, "");
    const cut = stem.lastIndexOf("-");
    [fileName, fileVersion] = [stem.slice(0, cut), stem.slice(cut + 1)];
  }
  const metaName = s.metaName ?? fileName;
  const metaVersion = s.metaVersion ?? fileVersion;
  const res = spawnSync("python3", [
    "-I",
    "-c",
    DIST_BUILDER,
    JSON.stringify({
      path: join(dir, s.file),
      metaName,
      metaVersion,
      dirName: s.dirName ?? `${metaName.replace(/-/g, "_")}-${metaVersion}`,
      shape: s.shape,
      extraHeaders: s.extraHeaders ?? "",
    }),
  ]);
  assert.equal(res.status, 0, String(res.stderr));
}

function runPy(opts: {
  packages: Array<{ name: string; newVersion: string; file?: string }>;
  dists: Record<string, DistSpec[]>; // artifact-relative dir -> distributions
  scope?: string;
  mutate?: (artifactDir: string) => void;
}) {
  const root = fixtureRoot();
  const artifacts = join(root, "py-canary-artifacts");
  mkdirSync(artifacts);
  for (const [dir, files] of Object.entries(opts.dists)) {
    mkdirSync(join(artifacts, dir), { recursive: true });
    for (const f of files) {
      // Non-distribution names are plain files; the validator must reject them by name.
      if (typeof f === "string" && !/\.(whl|tar\.gz)$/.test(f)) writeFileSync(join(artifacts, dir, f), "x");
      else writeDist(join(artifacts, dir), f);
    }
  }
  opts.mutate?.(artifacts);
  writeFileSync(
    join(root, "bump-result.json"),
    JSON.stringify({
      packages: opts.packages.map((p) => ({ ecosystem: "python", file: "sdks/python/pyproject.toml", ...p })),
    }),
  );
  const res = bash(pyValidate, {
    SCOPE: opts.scope ?? "demo-py",
    BUMP_RESULT: join(root, "bump-result.json"),
    PY_ARTIFACT_DIR: artifacts,
    RELEASE_CONFIG: join(root, "release.config.json"),
    MANIFEST: join(root, "manifest.json"),
  });
  let manifest: Array<{ name: string; version: string; files: string[] }> | null = null;
  if (res.code === 0) manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
  rmSync(root, { recursive: true, force: true });
  return { ...res, manifest };
}

const PY_OK = { name: "ag-ui-protocol", newVersion: "0.1.11.dev1730000000" };
const PY_FILES = ["ag_ui_protocol-0.1.11.dev1730000000-py3-none-any.whl", "ag_ui_protocol-0.1.11.dev1730000000.tar.gz"];

test("Python canary validation accepts dev releases at main's configured path", () => {
  const res = runPy({ packages: [PY_OK], dists: { "sdks/python/dist": PY_FILES } });
  assert.equal(res.code, 0, res.out);
  assert.equal(res.manifest?.length, 1);
  assert.equal(res.manifest?.[0].files.length, 2);
  assert.ok(res.manifest?.[0].files.every((f) => f.includes("/sdks/python/dist/")));
  // Legacy dashed sdist names normalize to the same project.
  const dashed = runPy({ packages: [PY_OK], dists: { "sdks/python/dist": ["ag-ui-protocol-0.1.11.dev1730000000.tar.gz"] } });
  assert.equal(dashed.code, 0, dashed.out);
});

test("Python canary validation rejects anything pip would treat as a normal release", () => {
  const reject = (label: string, opts: Parameters<typeof runPy>[0], why: RegExp) => {
    const res = runPy(opts);
    assert.notEqual(res.code, 0, `${label} was accepted`);
    assert.match(res.out, why, label);
  };
  // PyPI has no dist-tags: a non-dev version becomes the default install.
  for (const v of ["0.1.11", "99.0.0", "0.1.11rc1", "0.1.11a0", "0.1.11.post1", "0.1.11.dev1+local", "0.1.11.devfix"])
    reject(
      `version ${v}`,
      { packages: [{ ...PY_OK, newVersion: v }], dists: { "sdks/python/dist": [`ag_ui_protocol-${v}.tar.gz`] } },
      /is not X\.Y\.Z\.devN/,
    );
  reject("out-of-scope project", { packages: [{ ...PY_OK, name: "ag-ui-langgraph" }], dists: { "sdks/python/dist": PY_FILES } }, /not a Python package of scope/);
  reject("unknown scope", { packages: [PY_OK], dists: { "sdks/python/dist": PY_FILES }, scope: "nope" }, /not a Python package of scope/);
  reject("no python packages", { packages: [], dists: {} }, /lists no Python packages/);
  reject("duplicate package", { packages: [PY_OK, PY_OK], dists: { "sdks/python/dist": PY_FILES } }, /duplicate/);
  // The dist directory comes from main's config, never the bump result.
  reject(
    "bump result redirects path",
    { packages: [{ ...PY_OK, file: "evil/pyproject.toml" }], dists: { "evil/dist": PY_FILES } },
    /no dist\/ directory/,
  );
  reject("empty dist", { packages: [PY_OK], dists: { "sdks/python/dist": [] } }, /is empty/);
  reject(
    "foreign project wheel",
    { packages: [PY_OK], dists: { "sdks/python/dist": [...PY_FILES, "requests-99.0.0-py3-none-any.whl"] } },
    /different project/,
  );
  reject(
    "same project, stable version smuggled alongside",
    { packages: [PY_OK], dists: { "sdks/python/dist": [...PY_FILES, "ag_ui_protocol-99.0.0-py3-none-any.whl"] } },
    /is not version/,
  );
  reject(
    "non-distribution file",
    { packages: [PY_OK], dists: { "sdks/python/dist": [...PY_FILES, "uv.toml"] } },
    /not a wheel or sdist/,
  );
  reject(
    "symlinked distribution",
    {
      packages: [PY_OK],
      dists: { "sdks/python/dist": [PY_FILES[0]] },
      mutate: (a) => symlinkSync("/etc/hosts", join(a, "sdks/python/dist", PY_FILES[1])),
    },
    /not a regular file/,
  );
});

test("Python canary validation checks the identity uv actually uploads (embedded metadata)", () => {
  // uv sends the upload's name/version from the archive's METADATA / PKG-INFO,
  // not from its file name (verified offline against a loopback listener), so
  // a correctly named file must not be able to carry another identity.
  const W = PY_FILES[0];
  const S = PY_FILES[1];
  const reject = (label: string, spec: DistSpec, why: RegExp) => {
    const res = runPy({ packages: [PY_OK], dists: { "sdks/python/dist": [spec] } });
    assert.notEqual(res.code, 0, `${label} was accepted`);
    assert.match(res.out, why, label);
  };
  reject("wheel METADATA stable version", { file: W, metaVersion: "99.0.0", dirName: "ag_ui_protocol-0.1.11.dev1730000000" }, /METADATA Version '99\.0\.0'/);
  reject("wheel METADATA other project", { file: W, metaName: "requests", dirName: "ag_ui_protocol-0.1.11.dev1730000000" }, /METADATA Name 'requests' is a different project/);
  reject("wheel dist-info dir mismatch", { file: W, dirName: "ag_ui_protocol-99.0.0" }, /dist-info directory/);
  reject("sdist PKG-INFO stable version", { file: S, metaVersion: "99.0.0", dirName: "ag_ui_protocol-0.1.11.dev1730000000" }, /PKG-INFO Version '99\.0\.0'/);
  reject("sdist PKG-INFO other project", { file: S, metaName: "requests", dirName: "ag_ui_protocol-0.1.11.dev1730000000" }, /PKG-INFO Name 'requests'/);
  reject("sdist top-level dir mismatch", { file: S, dirName: "requests-0.1.11.dev1730000000" }, /sdist directory/);
  reject("wheel duplicate METADATA member", { file: W, shape: "dup-member" }, /duplicate members/);
  reject("sdist duplicate PKG-INFO member", { file: S, shape: "dup-member" }, /duplicate members/);
  reject("wheel without METADATA", { file: W, shape: "no-metadata" }, /exactly one top-level \*\.dist-info\/METADATA/);
  reject("sdist without PKG-INFO", { file: S, shape: "no-metadata" }, /exactly one regular top-level PKG-INFO/);
  reject("METADATA with two Name headers", { file: W, shape: "two-names" }, /exactly one Name/);
  reject("sdist with two top-level dirs", { file: S, shape: "extra-top" }, /exactly one top-level directory/);
  reject("sdist PKG-INFO symlink", { file: S, shape: "pkginfo-symlink" }, /regular top-level PKG-INFO/);
  reject("corrupt wheel", { file: W, shape: "corrupt" }, /unreadable archive/);
  reject("corrupt sdist", { file: S, shape: "corrupt" }, /unreadable archive/);
});

test("mixed scopes validate each ecosystem against its own allowlist", () => {
  const ts = runTs({ tarballs: [{ name: "@ag-ui/langgraph", version: "0.0.20-canary.1730000000.0" }], scope: "demo-mixed" });
  assert.equal(ts.code, 0, ts.out);
  const py = runPy({
    packages: [{ name: "ag-ui-langgraph", newVersion: "0.0.20.dev1730000000" }],
    dists: { "integrations/langgraph/python/dist": ["ag_ui_langgraph-0.0.20.dev1730000000-py3-none-any.whl"] },
    scope: "demo-mixed",
  });
  assert.equal(py.code, 0, py.out);
  const crossed = runTs({ tarballs: [{ name: "@ag-ui/core", version: "0.0.20-canary.1730000000.0" }], scope: "demo-mixed" });
  assert.notEqual(crossed.code, 0);
});

test("validators accept the real release config's current scopes", () => {
  // Guards against a config shape change silently emptying the allowlists.
  const real = JSON.parse(readFileSync("scripts/release/release.config.json", "utf8"));
  const sdkTs = real.scopes["sdk-ts"].packages.filter((p: { ecosystem: string }) => p.ecosystem === "typescript");
  assert.ok(sdkTs.length > 0);
  const root = mkdtempSync(join(tmpdir(), "release-authority-real-"));
  const dir = join(root, "t");
  mkdirSync(dir);
  const pkgs = sdkTs.map((p: { name: string }) => ({ name: p.name, version: "0.0.99-canary.1730000000.0" }));
  for (const p of pkgs) tarball(dir, tgzName(p.name, p.version), p);
  const res = bash(tsValidate, {
    SCOPE: "sdk-ts",
    EXPECTED_PACKAGES: JSON.stringify(pkgs),
    TARBALL_DIR: dir,
    RELEASE_CONFIG: join(process.cwd(), "scripts/release/release.config.json"),
    MANIFEST: join(root, "m.json"),
  });
  rmSync(root, { recursive: true, force: true });
  assert.equal(res.code, 0, res.out);
});

// ------------------------------------------------- post-publish PyPI read-back

// The verify step reads PYPI_BASE + /pypi/<name>/<version>/json. A file://
// base serves fixture JSON from disk, so no network is involved.
const pyVerify = runScript(step(job("publish"), "Verify Python uploads on PyPI"));

const V_NAME = "ag-ui-protocol";
const V_VERSION = "0.1.11.dev1730000000";
const V_WHL = "ag_ui_protocol-0.1.11.dev1730000000-py3-none-any.whl";
const V_SDIST = "ag_ui_protocol-0.1.11.dev1730000000.tar.gz";
// As a build backend writes them (single-quoted marker, specifier order as
// declared)...
const V_HEADERS =
  "Requires-Dist: pydantic>=2.11.2,<3\nRequires-Dist: fastapi>=0.115.12; extra == 'fastapi'\nRequires-Python: >=3.9\n";
// ...and as PyPI's JSON API re-renders them (double quotes, sorted specifiers),
// observed on real ag-ui releases.
const V_SHOWN = { requires_dist: ["pydantic<3,>=2.11.2", 'fastapi>=0.115.12; extra == "fastapi"'], requires_python: ">=3.9" };

type Remote = {
  info?: Record<string, unknown>;
  urls?: Array<{ filename: string; digests: { sha256: string } }>;
} | null;

function runVerify(opts: {
  dists?: DistSpec[];
  remote?: (sha: Record<string, string>) => Remote; // null: release not found
  published?: "none";
}) {
  const root = fixtureRoot();
  const dists = join(root, "dists");
  mkdirSync(dists);
  const specs = opts.dists ?? [
    { file: V_WHL, extraHeaders: V_HEADERS },
    { file: V_SDIST, extraHeaders: V_HEADERS },
  ];
  for (const d of specs) writeDist(dists, d);
  const files = specs.map((d) => join(dists, typeof d === "string" ? d : d.file));
  const sha = Object.fromEntries(
    files.map((f) => [f.split("/").pop()!, createHash("sha256").update(readFileSync(f)).digest("hex")]),
  );
  const published = join(root, "py-published.jsonl");
  writeFileSync(
    published,
    opts.published === "none" ? "" : JSON.stringify({ name: V_NAME, version: V_VERSION, files }) + "\n",
  );
  const remote = (opts.remote ?? defaultRemote)(sha);
  if (remote) {
    const dir = join(root, "pypi", V_NAME, V_VERSION);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "json"), JSON.stringify(remote));
  }
  const res = bash(pyVerify, {
    PY_PUBLISHED: published,
    PYPI_BASE: `file://${root}`,
    VERIFY_ATTEMPTS: "2",
    VERIFY_DELAY: "0",
  });
  rmSync(root, { recursive: true, force: true });
  return res;
}

function defaultRemote(sha: Record<string, string>): Remote {
  return {
    info: { name: V_NAME, version: V_VERSION, ...V_SHOWN },
    urls: Object.entries(sha).map(([filename, sha256]) => ({ filename, digests: { sha256 } })),
  };
}

test("PyPI read-back accepts a release that holds exactly our files and metadata", () => {
  const res = runVerify({});
  assert.equal(res.code, 0, res.out);
  assert.match(res.out, /ag-ui-protocol==0\.1\.11\.dev1730000000: verified/);
  // Wheel and sdist may legitimately differ (e.g. a setuptools sdist without
  // Requires-Dist); PyPI shows the metadata of whichever file was first.
  const differ = runVerify({ dists: [{ file: V_WHL, extraHeaders: V_HEADERS }, V_SDIST] });
  assert.equal(differ.code, 0, differ.out);
  const empty = runVerify({ published: "none" });
  assert.equal(empty.code, 0, empty.out);
  assert.match(empty.out, /nothing to verify/);
});

test("PyPI read-back rejects releases that differ from what this job uploaded", () => {
  const cases: Array<[string, (sha: Record<string, string>) => Remote, RegExp]> = [
    ["injected extra file", (sha) => {
      const r = defaultRemote(sha)!;
      r.urls!.push({ filename: "ag_ui_protocol-0.1.11.dev1730000000-cp312-cp312-manylinux_2_17_x86_64.whl", digests: { sha256: "0".repeat(64) } });
      return r;
    }, /files this job did not upload/],
    ["different bytes", (sha) => {
      const r = defaultRemote(sha)!;
      r.urls![0].digests.sha256 = "f".repeat(64);
      return r;
    }, /PyPI sha256/],
    ["forged extra dependency", (sha) => ({
      ...defaultRemote(sha),
      info: { name: V_NAME, version: V_VERSION, ...V_SHOWN, requires_dist: [...V_SHOWN.requires_dist, "evil-helper>=1"] },
    }), /matching none of the uploaded files/],
    ["dropped dependency", (sha) => ({
      ...defaultRemote(sha),
      info: { name: V_NAME, version: V_VERSION, ...V_SHOWN, requires_dist: ["pydantic<3,>=2.11.2"] },
    }), /matching none of the uploaded files/],
    ["changed specifier", (sha) => ({
      ...defaultRemote(sha),
      info: { name: V_NAME, version: V_VERSION, ...V_SHOWN, requires_dist: ["pydantic>=2.11.2", 'fastapi>=0.115.12; extra == "fastapi"'] },
    }), /matching none of the uploaded files/],
    ["forged Requires-Python", (sha) => ({
      ...defaultRemote(sha),
      info: { name: V_NAME, version: V_VERSION, ...V_SHOWN, requires_python: ">=2.7" },
    }), /matching none of the uploaded files/],
    ["other version", (sha) => ({ ...defaultRemote(sha), info: { ...defaultRemote(sha)!.info, version: "99.0.0" } }), /PyPI reports version/],
    ["other project", (sha) => ({ ...defaultRemote(sha), info: { ...defaultRemote(sha)!.info, name: "requests" } }), /PyPI reports project/],
    ["file never listed", (sha) => {
      const r = defaultRemote(sha)!;
      r.urls = r.urls!.slice(1);
      return r;
    }, /attempt 1\/2: not yet listed[\s\S]*not yet listed/],
    ["release not found", () => null, /attempt 1\/2/],
  ];
  for (const [label, remote, why] of cases) {
    const res = runVerify({ remote });
    assert.notEqual(res.code, 0, `${label}: accepted\n${res.out}`);
    assert.match(res.out, /::error::PyPI verification failed for ag-ui-protocol==0\.1\.11\.dev1730000000/, label);
    assert.match(res.out, why, `${label}: ${res.out}`);
  }
});

test("PyPI read-back runs after every Python upload and before tags/releases", () => {
  const publish = job("publish");
  const names = stepNames(publish);
  const at = (n: string) => {
    const i = names.indexOf(n);
    assert.ok(i >= 0, `missing step ${n}`);
    return i;
  };
  const verify = at("Verify Python uploads on PyPI");
  assert.ok(verify > at("Publish Python packages (stable)"));
  assert.ok(verify > at("Publish Python canary (prerelease)"));
  assert.ok(verify < at("Fail if any packages failed to publish"));
  assert.ok(verify < at("Create and push per-package git tags (Python)"));
  const cond = stepIf(step(publish, "Verify Python uploads on PyPI"));
  for (const part of ["needs.build.outputs.py_count != '0'", "needs.build.outputs.pre_has_py_packages == 'true'"])
    assert.ok(step(publish, "Verify Python uploads on PyPI").includes(part), `verify condition lacks ${part} (${cond})`);
  const block = step(publish, "Verify Python uploads on PyPI");
  assert.match(block, /PYPI_BASE: https:\/\/pypi\.org$/m);
  assert.match(block, /python3 -I - <<'PY'/);
  assert.doesNotMatch(block, /pip install|uv (?:pip|run|tool)/);
  // Both publish loops record exactly what uv uploaded, only on success.
  for (const p of ["Publish Python packages (stable)", "Publish Python canary (prerelease)"]) {
    const s = step(publish, p);
    assert.match(s, /PY_PUBLISHED: \$\{\{ runner\.temp \}\}\/py-published\.jsonl/, p);
    assert.match(s, /else\n[\s\S]*>> "\$PY_PUBLISHED"/, p);
  }
});

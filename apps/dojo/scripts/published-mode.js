#!/usr/bin/env node
/**
 * Dojo "published mode".
 *
 * Rewrites a checkout so the Dojo lanes run against the latest PUBLISHED
 * releases (npm / PyPI / NuGet) instead of repo source:
 *
 *   - npm:   every `@ag-ui/*` dependency of apps/dojo (and of the lane example
 *            packages it runs) is pinned to the version npm's `latest` dist-tag
 *            points at. Packages that are not on npm stay `workspace:*`, and
 *            their own `@ag-ui/*` dependencies are rewritten the same way, so the
 *            source-only packages still run against published core/client.
 *            tsconfig `paths` that alias `@ag-ui/*` to repo source are removed.
 *   - PyPI:  each lane's example pyproject has the integration package (ours or
 *            the upstream producer's) pinned to `>=<PyPI latest>`, path /
 *            `[tool.uv.sources]` overrides for it and for `ag-ui-protocol` are
 *            dropped, `ag-ui-protocol` bounds are relaxed so the resolver can
 *            pick the newest release, and the lock is deleted so `uv sync` /
 *            `poetry install` re-resolve from scratch.
 *   - NuGet: ProjectReferences to AG-UI .NET SDK projects that are on NuGet are
 *            swapped for PackageReferences at the latest version; upstream
 *            package families (Microsoft Agent Framework) are bumped to latest.
 *
 * It is meant for a throwaway CI checkout (or a scratch copy). It edits files
 * in place and records what it did in `.published-mode/state.json` under the
 * root, which `report` reads back to produce the per-lane version table.
 *
 * Usage:
 *   node apps/dojo/scripts/published-mode.js apply --lanes agno,mastra [--dry-run] [--root DIR]
 *   node apps/dojo/scripts/published-mode.js apply --all
 *   node apps/dojo/scripts/published-mode.js report --lane agno --outcome success [--out FILE]
 *   node apps/dojo/scripts/published-mode.js summarize --dir DIR [--fail-on-failure]
 *   node apps/dojo/scripts/published-mode.js list
 *
 * Lane ids are the `suite` names of the dojo-e2e.yml matrix.
 */

const fs = require("fs");
const path = require("path");

// --------------------------------------------------------------------------
// Lane table
// --------------------------------------------------------------------------

// Python packages whose example-level bounds are relaxed (not forced) so the
// resolver picks the newest release the producer allows. The resolved version
// is reported and flagged when it is not the PyPI latest.
const PY_FLOAT = ["ag-ui-protocol", "ag-ui-a2ui-toolkit"];

const LANES = {
  "a2a-middleware": {
    npm: ["@ag-ui/a2a-middleware", "@ag-ui/a2a"],
    python: { dir: "middlewares/a2a-middleware/examples", tool: "uv", producers: ["ag-ui-adk"] },
  },
  "adk-middleware": {
    npm: ["@ag-ui/adk"],
    python: { dir: "integrations/adk-middleware/python/examples", tool: "uv", producers: ["ag-ui-adk"] },
  },
  "adk-js": {
    npm: ["@ag-ui/adk-js"],
    npmRoots: ["integrations/adk-middleware/js/examples"],
  },
  agno: {
    npm: ["@ag-ui/agno"],
    python: { dir: "integrations/agno/python/examples", tool: "uv", producers: ["agno"] },
  },
  "crew-ai": {
    npm: ["@ag-ui/crewai"],
    python: { dir: "integrations/crew-ai/python/examples", tool: "uv", producers: ["ag-ui-crewai"] },
  },
  "crewai-conversational-flows": {
    npm: ["@ag-ui/crewai"],
    python: { dir: "integrations/crew-ai/python/examples", tool: "uv", producers: ["ag-ui-crewai"] },
  },
  langroid: {
    npm: ["@ag-ui/langroid"],
    python: { dir: "integrations/langroid/python/examples", tool: "uv", producers: ["ag-ui-langroid"] },
  },
  "langgraph-python": {
    npm: ["@ag-ui/langgraph"],
    python: { dir: "integrations/langgraph/python/examples", tool: "uv", producers: ["ag-ui-langgraph"] },
  },
  "langgraph-fastapi": {
    npm: ["@ag-ui/langgraph"],
    python: { dir: "integrations/langgraph/python/examples", tool: "uv", producers: ["ag-ui-langgraph"] },
  },
  "langgraph-typescript": {
    npm: ["@ag-ui/langgraph"],
    npmRoots: ["integrations/langgraph/typescript/examples"],
  },
  "llama-index": {
    npm: ["@ag-ui/llamaindex"],
    python: {
      dir: "integrations/llama-index/python/examples",
      tool: "uv",
      producers: ["llama-index-protocols-ag-ui"],
    },
  },
  mastra: {
    npm: ["@ag-ui/mastra"],
    npmRoots: ["integrations/mastra/typescript/examples"],
  },
  "mastra-agent-local": { npm: ["@ag-ui/mastra"] },
  "middleware-starter": { npm: ["@ag-ui/middleware-starter"] },
  "pydantic-ai": {
    npm: ["@ag-ui/pydantic-ai"],
    python: { dir: "integrations/pydantic-ai/python/examples", tool: "uv", producers: ["pydantic-ai-slim"] },
  },
  "server-starter": {
    npm: ["@ag-ui/server-starter"],
    python: { dir: "integrations/server-starter/python/examples", tool: "uv", producers: ["ag-ui-protocol"] },
  },
  "server-starter-all": {
    npm: ["@ag-ui/server-starter-all-features"],
    python: {
      dir: "integrations/server-starter-all-features/python/examples",
      tool: "uv",
      producers: ["ag-ui-protocol"],
    },
  },
  "aws-strands": {
    npm: ["@ag-ui/aws-strands"],
    python: { dir: "integrations/aws-strands/python/examples", tool: "poetry", producers: ["ag-ui-strands"] },
  },
  "aws-strands-typescript": {
    npm: ["@ag-ui/aws-strands"],
    npmRoots: ["integrations/aws-strands/typescript/examples"],
  },
  "claude-agent-sdk-python": {
    npm: ["@ag-ui/claude-agent-sdk"],
    python: {
      dir: "integrations/claude-agent-sdk/python/examples",
      tool: "uv",
      producers: ["ag-ui-claude-sdk"],
    },
  },
  "claude-agent-sdk-typescript": {
    npm: ["@ag-ui/claude-agent-sdk"],
    // The lane's server (examples/server.ts) imports the adapter from ../src,
    // so the adapter itself always runs from source; only its @ag-ui/* deps
    // are switched to published releases.
    npmRoots: ["integrations/claude-agent-sdk/typescript"],
    note: "adapter runs from source (examples import ../src); @ag-ui/* deps are published",
  },
  ag2: {
    npm: ["@ag-ui/ag2"],
    python: { dir: "integrations/ag2/python/examples", tool: "uv", producers: ["ag2"] },
  },
  "microsoft-agent-framework-python": {
    python: {
      dir: "integrations/microsoft-agent-framework/python/examples",
      tool: "uv",
      producers: ["agent-framework-ag-ui"],
    },
  },
  "microsoft-agent-framework-dotnet": {
    dotnet: {
      csproj: "integrations/microsoft-agent-framework/dotnet/examples/AGUIDojoServer/AGUIDojoServer.csproj",
      bump: ["Microsoft.Agents.AI."],
      // Direct pins the example carries only to satisfy the old MAF preview; left
      // in place they downgrade what the latest MAF needs (NU1605).
      unpin: ["OpenAI", "System.Net.ServerSentEvents"],
    },
  },
  "ag-ui-dotnet": {
    dotnet: {
      csproj: "sdks/dotnet/samples/AGUIClientServer/AGUIDojoServer/AGUIDojoServer.csproj",
      swapProjectRefs: true,
    },
  },
};

// Every lane also exercises the dojo app and its core protocol packages.
const DOJO_NPM_ROOT = "apps/dojo";
const DOJO_CORE_PACKAGES = ["@ag-ui/core", "@ag-ui/client"];
const STATE_DIR = ".published-mode";
const NPM_DEP_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

// --------------------------------------------------------------------------
// CLI
// --------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) out[key] = true;
      else {
        out[key] = next;
        i++;
      }
    } else out._.push(a);
  }
  return out;
}

const HELP = `Usage: node published-mode.js <command> [options]

Commands:
  apply       Rewrite manifests to the latest published releases
                --lanes a,b   lanes to rewrite (dojo-e2e matrix suite names)
                --all         all lanes
                --dry-run     print the planned changes, write nothing
  report      Write the per-lane version table (markdown to $GITHUB_STEP_SUMMARY
              or stdout, JSON to --out)
                --lane NAME --outcome success|failure|cancelled [--out FILE]
  summarize   Merge report JSON files into one table
                --dir DIR [--fail-on-failure]
  list        List known lanes

Common options:
  --root DIR    Repository root to operate on (default: this checkout)
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  const root = path.resolve(args.root || path.join(__dirname, "..", "..", ".."));

  if (!cmd || args.help || args.h) {
    console.log(HELP);
    return;
  }
  if (cmd === "list") {
    for (const [name, lane] of Object.entries(LANES)) {
      const eco = ["npm", lane.python && `pypi(${lane.python.tool})`, lane.dotnet && "nuget"].filter(Boolean);
      console.log(`${name.padEnd(36)} ${eco.join(", ")}`);
    }
    return;
  }
  if (cmd === "apply") return apply(root, args);
  if (cmd === "report") return report(root, args);
  if (cmd === "summarize") return summarize(args);
  throw new Error(`Unknown command: ${cmd}\n\n${HELP}`);
}

// --------------------------------------------------------------------------
// Registry lookups
// --------------------------------------------------------------------------

const cache = new Map();
async function cached(key, fn) {
  if (!cache.has(key)) cache.set(key, fn());
  return cache.get(key);
}

async function fetchJson(url) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { accept: "application/json" } });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  throw lastErr;
}

/** Version npm's `latest` dist-tag points at, or null when not published. */
function npmLatest(name) {
  const registry = (process.env.NPM_CONFIG_REGISTRY || "https://registry.npmjs.org").replace(/\/$/, "");
  return cached(`npm:${name}`, async () => {
    const doc = await fetchJson(`${registry}/${name.replace("/", "%2F")}/latest`);
    return doc && doc.version ? doc.version : null;
  });
}

/** Latest non-yanked release on PyPI (PyPI's own "latest", which skips pre-releases). */
function pypiLatest(name) {
  return cached(`pypi:${name}`, async () => {
    const doc = await fetchJson(`https://pypi.org/pypi/${name}/json`);
    return doc && doc.info ? doc.info.version : null;
  });
}

/** Latest stable NuGet version, or the latest pre-release when no stable exists. */
function nugetLatest(id) {
  return cached(`nuget:${id}`, async () => {
    const doc = await fetchJson(`https://api.nuget.org/v3-flatcontainer/${id.toLowerCase()}/index.json`);
    const versions = (doc && doc.versions) || [];
    if (!versions.length) return null;
    const stable = versions.filter((v) => !v.includes("-"));
    return (stable.length ? stable : versions)[(stable.length ? stable : versions).length - 1];
  });
}

// --------------------------------------------------------------------------
// apply
// --------------------------------------------------------------------------

function selectLanes(args) {
  if (args.all) return Object.keys(LANES);
  if (!args.lanes || args.lanes === true) throw new Error("apply needs --lanes a,b or --all");
  const lanes = String(args.lanes)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const unknown = lanes.filter((l) => !LANES[l]);
  if (unknown.length) throw new Error(`Unknown lane(s): ${unknown.join(", ")}. Run 'list' to see lanes.`);
  return lanes;
}

async function apply(root, args) {
  const dryRun = Boolean(args["dry-run"]);
  const lanes = selectLanes(args);
  const writer = new Writer(root, dryRun);
  const state = { appliedAt: new Date().toISOString(), lanes: {}, changes: writer.changes };

  // npm: the dojo app plus each lane's own example packages, rewritten once.
  const npmRoots = new Set([DOJO_NPM_ROOT]);
  for (const lane of lanes) for (const r of LANES[lane].npmRoots || []) npmRoots.add(r);
  const npmResult = await rewriteNpm(root, [...npmRoots], writer);
  const pythonDone = new Map();

  for (const lane of lanes) {
    const def = LANES[lane];
    const packages = [];
    const laneNpmRoots = [DOJO_NPM_ROOT, ...(def.npmRoots || [])];
    for (const name of [...DOJO_CORE_PACKAGES, ...(def.npm || [])]) {
      const info = npmResult.get(name);
      packages.push({
        ecosystem: "npm",
        name,
        latest: info ? info.latest : await npmLatest(name),
        mode: info ? info.mode : "unknown",
        roots: laneNpmRoots,
      });
    }
    if (def.python) {
      // Several lanes share one example dir (e.g. langgraph-python / -fastapi).
      if (!pythonDone.has(def.python.dir)) pythonDone.set(def.python.dir, await rewritePython(root, def.python, writer));
      packages.push(...pythonDone.get(def.python.dir));
    }
    if (def.dotnet) packages.push(...(await rewriteDotnet(root, def.dotnet, writer)));
    state.lanes[lane] = { packages, note: def.note };
  }

  if (!dryRun) {
    fs.mkdirSync(path.join(root, STATE_DIR), { recursive: true });
    fs.writeFileSync(path.join(root, STATE_DIR, "state.json"), JSON.stringify(state, null, 2) + "\n");
  }

  console.log(`${dryRun ? "[dry-run] " : ""}published mode for lanes: ${lanes.join(", ")}`);
  for (const c of writer.changes) console.log(`  ${c}`);
  for (const lane of lanes) {
    console.log(`\n${lane}`);
    for (const p of state.lanes[lane].packages) {
      console.log(`  ${p.ecosystem.padEnd(6)} ${p.name.padEnd(44)} latest=${p.latest || "-"} (${p.mode})`);
    }
  }
}

class Writer {
  constructor(root, dryRun) {
    this.root = root;
    this.dryRun = dryRun;
    this.changes = [];
  }
  rel(file) {
    return path.relative(this.root, file);
  }
  write(file, content, what) {
    if (fs.readFileSync(file, "utf8") === content) return;
    this.changes.push(`edit   ${this.rel(file)}: ${what}`);
    if (!this.dryRun) fs.writeFileSync(file, content);
  }
  remove(file) {
    if (!fs.existsSync(file)) return;
    this.changes.push(`delete ${this.rel(file)}`);
    if (!this.dryRun) fs.rmSync(file);
  }
}

// ---- npm ------------------------------------------------------------------

function workspacePackages(root) {
  const yaml = fs.readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8");
  const patterns = [];
  let inPackages = false;
  for (const line of yaml.split("\n")) {
    if (/^packages:\s*$/.test(line)) inPackages = true;
    else if (/^\S/.test(line)) inPackages = false;
    else if (inPackages) {
      const m = line.match(/^\s*-\s*["']?([^"'#]+?)["']?\s*$/);
      if (m) patterns.push(m[1]);
    }
  }
  const byName = new Map();
  for (const pattern of patterns) {
    for (const dir of expandGlob(root, pattern.split("/"))) {
      const pj = path.join(dir, "package.json");
      if (!fs.existsSync(pj)) continue;
      const name = JSON.parse(fs.readFileSync(pj, "utf8")).name;
      if (name) byName.set(name, dir);
    }
  }
  return byName;
}

function expandGlob(base, segments) {
  if (!segments.length) return [base];
  const [head, ...rest] = segments;
  if (head !== "*") return fs.existsSync(path.join(base, head)) ? expandGlob(path.join(base, head), rest) : [];
  return fs
    .readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== "node_modules" && !d.name.startsWith("."))
    .flatMap((d) => expandGlob(path.join(base, d.name), rest));
}

/**
 * Rewrites `@ag-ui/*` deps in the given package dirs to npm latest. Workspace
 * packages that are not published stay `workspace:*` and are rewritten
 * recursively, so their own `@ag-ui/*` deps also come from npm.
 * Returns name -> { latest, mode } where mode is "npm" or "source (not on npm)".
 */
async function rewriteNpm(root, rootDirs, writer) {
  const workspace = workspacePackages(root);
  const result = new Map();
  const queue = rootDirs.map((d) => path.join(root, d));
  const seen = new Set();

  while (queue.length) {
    const dir = queue.shift();
    if (seen.has(dir)) continue;
    seen.add(dir);
    const file = path.join(dir, "package.json");
    const original = fs.readFileSync(file, "utf8");
    const pkg = JSON.parse(original);
    const inWorkspace = workspace.get(pkg.name) === dir;
    const edits = [];

    for (const field of NPM_DEP_FIELDS) {
      for (const [name, spec] of Object.entries(pkg[field] || {})) {
        if (!name.startsWith("@ag-ui/")) continue;
        const latest = await npmLatest(name);
        if (latest) {
          result.set(name, { latest, mode: "npm" });
          // Inside the workspace only `workspace:` links point at repo source;
          // plain ranges (e.g. peer ranges of a source-built package) already
          // resolve from npm and are left alone. Standalone example projects
          // (own lockfile) pin a version, which is moved to latest.
          const rewrite = spec.startsWith("workspace:") || (!inWorkspace && field !== "peerDependencies");
          if (rewrite && spec !== latest) {
            pkg[field][name] = latest;
            edits.push(`${name} ${spec} -> ${latest}`);
          }
        } else {
          result.set(name, { latest: null, mode: "source (not on npm)" });
          if (spec.startsWith("workspace:") && workspace.has(name)) queue.push(workspace.get(name));
        }
      }
    }
    if (edits.length) {
      const indent = (original.match(/^\{\n([ \t]+)/) || [, "  "])[1];
      const eol = original.endsWith("\n") ? "\n" : "";
      writer.write(file, JSON.stringify(pkg, null, indent) + eol, edits.join(", "));
    }
    stripSourcePathAliases(root, dir, writer);
  }
  return result;
}

/**
 * Drops tsconfig `paths` targets that point outside the package into repo
 * source (e.g. apps/dojo aliases `@ag-ui/client` to sdks/typescript/...),
 * which would otherwise bypass node_modules entirely.
 */
function stripSourcePathAliases(root, dir, writer) {
  const file = path.join(dir, "tsconfig.json");
  if (!fs.existsSync(file)) return;
  let tsconfig;
  try {
    tsconfig = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return; // JSONC with comments: none of the rewritten roots use it today.
  }
  const paths = tsconfig.compilerOptions && tsconfig.compilerOptions.paths;
  if (!paths) return;
  const removed = [];
  for (const [alias, targets] of Object.entries(paths)) {
    const kept = targets.filter((t) => {
      const abs = path.resolve(dir, t);
      const outside = !abs.startsWith(dir + path.sep) && abs !== dir;
      const intoRepoSource = abs.startsWith(root + path.sep) && /\/(sdks|integrations|middlewares)\//.test(abs);
      return !(outside && intoRepoSource);
    });
    if (kept.length === targets.length) continue;
    removed.push(alias);
    if (kept.length) paths[alias] = kept;
    else delete paths[alias];
  }
  if (removed.length) {
    writer.write(file, JSON.stringify(tsconfig, null, 2) + "\n", `drop repo-source path targets for ${removed.join(", ")}`);
  }
}

// ---- Python ---------------------------------------------------------------

const normalizePy = (n) => n.toLowerCase().replace(/[-_.]+/g, "-");

async function rewritePython(root, def, writer) {
  const dir = path.join(root, def.dir);
  const pyproject = path.join(dir, "pyproject.toml");
  const producers = new Map();
  for (const name of def.producers) producers.set(normalizePy(name), { name, latest: await pypiLatest(name) });
  for (const p of producers.values()) if (!p.latest) throw new Error(`${p.name} is not on PyPI (lane dir ${def.dir})`);
  const floats = PY_FLOAT.map(normalizePy).filter((n) => !producers.has(n));

  let text = fs.readFileSync(pyproject, "utf8");
  const before = text;
  if (def.tool === "uv") {
    text = rewriteUvPyproject(text, producers, new Set(floats));
    writer.write(pyproject, text, describeProducers(producers));
    writer.remove(path.join(dir, "uv.lock"));
  } else if (def.tool === "poetry") {
    text = rewritePoetryPyproject(text, producers, new Set(floats));
    writer.write(pyproject, text, describeProducers(producers));
    writer.remove(path.join(dir, "poetry.lock"));
  } else {
    throw new Error(`Unsupported python tool ${def.tool}`);
  }

  const packages = [];
  for (const p of producers.values()) {
    packages.push({ ecosystem: "pypi", name: p.name, latest: p.latest, mode: "pinned >= latest", dir: def.dir, tool: def.tool });
  }
  for (const name of PY_FLOAT) {
    if (producers.has(normalizePy(name))) continue;
    if (name !== "ag-ui-protocol" && !new RegExp(`["'\\s]${name.replace(/-/g, "[-_.]")}`, "i").test(before)) continue;
    packages.push({ ecosystem: "pypi", name, latest: await pypiLatest(name), mode: "newest allowed", dir: def.dir, tool: def.tool });
  }
  return packages;
}

function describeProducers(producers) {
  return [...producers.values()].map((p) => `${p.name}>=${p.latest}`).join(", ") + ", relock from scratch";
}

/** Splits a PEP 508 string into name, extras, version spec and marker. */
function parseRequirement(req) {
  const [main, ...markerParts] = req.split(";");
  const m = main.trim().match(/^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[[^\]]*\])?\s*(.*)$/);
  if (!m) return null;
  return { name: m[1], extras: m[2] || "", spec: m[3].trim(), marker: markerParts.length ? markerParts.join(";").trim() : "" };
}

function formatRequirement({ name, extras, spec, marker }) {
  return `${name}${extras}${spec}${marker ? `; ${marker}` : ""}`;
}

/** Locates `key = [ ... ]` inside `[section]` and returns [start, end) of the array (inclusive brackets). */
function findTomlArray(text, section, key) {
  const lines = text.split("\n");
  let offset = 0;
  let current = null;
  for (const line of lines) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*(#.*)?$/);
    if (header) current = header[1].trim();
    else if (current === section) {
      const m = line.match(new RegExp(`^\\s*${key}\\s*=\\s*\\[`));
      if (m) {
        const start = offset + m[0].length - 1;
        return [start, scanArrayEnd(text, start)];
      }
    }
    offset += line.length + 1;
  }
  return null;
}

function scanArrayEnd(text, start) {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'") {
      const end = text.indexOf(c, i + 1);
      i = end;
    } else if (c === "#") {
      i = text.indexOf("\n", i);
      if (i === -1) break;
    } else if (c === "[") depth++;
    else if (c === "]" && --depth === 0) return i + 1;
  }
  throw new Error("Unterminated TOML array");
}

function rewriteUvPyproject(text, producers, floats) {
  const range = findTomlArray(text, "project", "dependencies");
  if (!range) throw new Error("pyproject.toml has no [project] dependencies array");
  let array = text.slice(range[0], range[1]);
  const present = new Set();
  array = array.replace(/(["'])([^"'\n]+)\1/g, (whole, quote, req) => {
    const parsed = parseRequirement(req);
    if (!parsed) return whole;
    const key = normalizePy(parsed.name);
    if (producers.has(key)) {
      present.add(key);
      return quote + formatRequirement({ ...parsed, spec: `>=${producers.get(key).latest}` }) + quote;
    }
    if (floats.has(key)) return quote + formatRequirement({ ...parsed, spec: "" }) + quote;
    return whole;
  });
  const missing = [...producers].filter(([k]) => !present.has(k));
  if (missing.length) {
    const insert = missing.map(([, p]) => `    "${p.name}>=${p.latest}",\n`).join("");
    const body = array.slice(0, -1).replace(/\s*$/, "");
    const sep = body.endsWith("[") || body.endsWith(",") ? "" : ",";
    array = `${body}${sep}\n${insert}]`;
  }
  text = text.slice(0, range[0]) + array + text.slice(range[1]);
  return dropTomlTableKeys(text, "tool.uv.sources", (key) => producers.has(key) || floats.has(key));
}

function rewritePoetryPyproject(text, producers, floats) {
  const lines = text.split("\n");
  let current = null;
  let lastDepLine = -1;
  const present = new Set();
  const out = lines.map((line, idx) => {
    const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (header) {
      current = header[1].trim();
      return line;
    }
    if (current !== "tool.poetry.dependencies") return line;
    const m = line.match(/^(\s*)(["']?)([A-Za-z0-9._-]+)\2\s*=\s*(.*)$/);
    if (!m) return line;
    lastDepLine = idx;
    const key = normalizePy(m[3]);
    const extras = (m[4].match(/extras\s*=\s*(\[[^\]]*\])/) || [])[1];
    const constraint = producers.has(key) ? `>=${producers.get(key).latest}` : floats.has(key) ? "*" : null;
    if (!constraint) return line;
    present.add(key);
    const name = producers.has(key) ? producers.get(key).name : m[3];
    return extras ? `${m[1]}${name} = { version = "${constraint}", extras = ${extras} }` : `${m[1]}${name} = "${constraint}"`;
  });
  if (lastDepLine === -1) throw new Error("pyproject.toml has no [tool.poetry.dependencies]");
  const missing = [...producers].filter(([k]) => !present.has(k)).map(([, p]) => `${p.name} = ">=${p.latest}"`);
  out.splice(lastDepLine + 1, 0, ...missing);
  return out.join("\n");
}

/** Removes `key = ...` lines (single-line values) from a TOML table. */
function dropTomlTableKeys(text, table, shouldDrop) {
  let current = null;
  return text
    .split("\n")
    .filter((line) => {
      const header = line.match(/^\s*\[([^\]]+)\]\s*(#.*)?$/);
      if (header) {
        current = header[1].trim();
        return true;
      }
      if (current !== table) return true;
      const m = line.match(/^\s*(["']?)([A-Za-z0-9._-]+)\1\s*=/);
      return !(m && shouldDrop(normalizePy(m[2])));
    })
    .join("\n");
}

// ---- .NET -----------------------------------------------------------------

async function rewriteDotnet(root, def, writer) {
  const packages = [];
  const entry = path.join(root, def.csproj);
  if (def.bump) {
    let text = fs.readFileSync(entry, "utf8");
    const edits = [];
    const re = /<PackageReference\s+Include="([^"]+)"\s+Version="([^"]+)"/g;
    for (const [, id, version] of [...text.matchAll(re)]) {
      if (!def.bump.some((prefix) => id.startsWith(prefix))) continue;
      const latest = await nugetLatest(id);
      if (!latest) throw new Error(`${id} is not on NuGet`);
      packages.push({ ecosystem: "nuget", name: id, latest, mode: "PackageReference -> latest", csproj: def.csproj });
      if (latest === version) continue;
      text = text.replace(`Include="${id}" Version="${version}"`, `Include="${id}" Version="${latest}"`);
      edits.push(`${id} ${version} -> ${latest}`);
    }
    for (const id of def.unpin || []) {
      const ref = new RegExp(`[ \\t]*<PackageReference\\s+Include="${id.replace(/\./g, "\\.")}"[^>]*/>\\r?\\n?`);
      if (!ref.test(text)) continue;
      text = text.replace(ref, "");
      edits.push(`unpin ${id}`);
    }
    if (edits.length) writer.write(entry, text, edits.join(", "));
  }
  if (def.swapProjectRefs) {
    const queue = [entry];
    const seen = new Set();
    while (queue.length) {
      const file = queue.shift();
      if (seen.has(file)) continue;
      seen.add(file);
      let text = fs.readFileSync(file, "utf8");
      const central = usesCentralPackageManagement(root, path.dirname(file));
      const edits = [];
      for (const m of [...text.matchAll(/<ProjectReference\s+Include="([^"]+)"\s*\/>/g)]) {
        const target = path.resolve(path.dirname(file), m[1].replace(/\\/g, "/"));
        const id = packageIdOf(target);
        const latest = id && (await nugetLatest(id));
        if (!latest) {
          queue.push(target); // not on NuGet: keep building from source, but swap its refs too
          continue;
        }
        const attr = central ? "VersionOverride" : "Version";
        text = text.replace(m[0], `<PackageReference Include="${id}" ${attr}="${latest}" />`);
        edits.push(`${id} ProjectReference -> ${latest}`);
        if (!packages.some((p) => p.name === id)) {
          packages.push({ ecosystem: "nuget", name: id, latest, mode: "ProjectReference -> NuGet", csproj: def.csproj });
        }
      }
      if (edits.length) writer.write(file, text, edits.join(", "));
    }
    const sourceOnly = [...seen].filter((f) => f !== entry).map((f) => path.basename(f, ".csproj"));
    for (const name of sourceOnly) {
      packages.push({ ecosystem: "nuget", name, latest: null, mode: "source (not on NuGet)", csproj: def.csproj });
    }
  }
  return packages;
}

function packageIdOf(csproj) {
  if (!fs.existsSync(csproj)) return null;
  const text = fs.readFileSync(csproj, "utf8");
  if (/<IsPackable>\s*false\s*<\/IsPackable>/i.test(text)) return null;
  const m = text.match(/<PackageId>([^<]+)<\/PackageId>/);
  return m ? m[1].trim() : null;
}

function usesCentralPackageManagement(root, dir) {
  for (let d = dir; d.startsWith(root); d = path.dirname(d)) {
    const props = path.join(d, "Directory.Packages.props");
    if (fs.existsSync(props)) {
      return /<ManagePackageVersionsCentrally>\s*true\s*</i.test(fs.readFileSync(props, "utf8"));
    }
    if (d === root) break;
  }
  return false;
}

// --------------------------------------------------------------------------
// report / summarize
// --------------------------------------------------------------------------

function readState(root) {
  const file = path.join(root, STATE_DIR, "state.json");
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}

function resolvedNpm(root, pkg) {
  for (const r of pkg.roots || [DOJO_NPM_ROOT]) {
    const pj = path.join(root, r, "node_modules", pkg.name, "package.json");
    if (!fs.existsSync(pj)) continue;
    const real = fs.realpathSync(pj);
    const fromRegistry = real.includes(`${path.sep}node_modules${path.sep}`);
    return { version: JSON.parse(fs.readFileSync(pj, "utf8")).version, source: fromRegistry ? "npm" : "workspace" };
  }
  return null;
}

function lockPackages(file) {
  if (!fs.existsSync(file)) return new Map();
  const map = new Map();
  for (const block of fs.readFileSync(file, "utf8").split(/^\[\[package\]\]\s*$/m).slice(1)) {
    const name = (block.match(/^name = "([^"]+)"/m) || [])[1];
    const version = (block.match(/^version = "([^"]+)"/m) || [])[1];
    if (!name) continue;
    const local = /^source = \{ (editable|directory|path) =/m.test(block) || /^type = "directory"/m.test(block);
    map.set(normalizePy(name), { version, source: local ? "path" : "pypi" });
  }
  return map;
}

function resolvedPython(root, pkg) {
  const lock = path.join(root, pkg.dir, pkg.tool === "poetry" ? "poetry.lock" : "uv.lock");
  return lockPackages(lock).get(normalizePy(pkg.name)) || null;
}

function resolvedNuget(root, pkg) {
  const assets = path.join(root, path.dirname(pkg.csproj), "obj", "project.assets.json");
  if (!fs.existsSync(assets)) return null;
  const libs = JSON.parse(fs.readFileSync(assets, "utf8")).libraries || {};
  for (const [key, lib] of Object.entries(libs)) {
    const [name, version] = key.split("/");
    if (name.toLowerCase() === pkg.name.toLowerCase()) return { version, source: lib.type === "project" ? "source" : "nuget" };
  }
  return null;
}

function report(root, args) {
  const lane = args.lane;
  if (!lane || lane === true) throw new Error("report needs --lane NAME");
  const outcome = typeof args.outcome === "string" ? args.outcome : "unknown";
  const state = readState(root);
  const laneState = state && state.lanes[lane];
  const rows = [];
  for (const pkg of (laneState && laneState.packages) || []) {
    const resolved =
      pkg.ecosystem === "npm"
        ? resolvedNpm(root, pkg)
        : pkg.ecosystem === "pypi"
          ? resolvedPython(root, pkg)
          : resolvedNuget(root, pkg);
    rows.push({
      lane,
      ecosystem: pkg.ecosystem,
      package: pkg.name,
      latest: pkg.latest,
      resolved: resolved ? resolved.version : null,
      source: resolved ? resolved.source : pkg.mode,
      outcome,
    });
  }
  const result = { lane, outcome, note: laneState ? laneState.note : "published-mode state missing", rows };
  if (typeof args.out === "string") {
    fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
    fs.writeFileSync(args.out, JSON.stringify(result, null, 2) + "\n");
  }
  emitMarkdown(renderTable([result], `Published mode: ${lane}`));
}

function summarize(args) {
  const dir = args.dir;
  if (!dir || dir === true) throw new Error("summarize needs --dir DIR");
  const results = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".json")) results.push(JSON.parse(fs.readFileSync(p, "utf8")));
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  results.sort((a, b) => a.lane.localeCompare(b.lane));
  const failed = results.filter((r) => r.outcome !== "success");
  const header =
    `Dojo published-release compatibility (${results.length} lanes, ` +
    `${results.length - failed.length} passed, ${failed.length} failed)`;
  emitMarkdown(renderTable(results, header));
  if (args["fail-on-failure"] && (failed.length || !results.length)) {
    console.error(results.length ? `Failing lanes: ${failed.map((r) => r.lane).join(", ")}` : "No lane reports found");
    process.exitCode = 1;
  }
}

function renderTable(results, title) {
  const icon = (o) => (o === "success" ? "pass" : o === "unknown" ? "?" : "FAIL");
  const lines = [
    `### ${title}`,
    "",
    "| Lane | Result | Ecosystem | Package | Resolved | Latest | Source |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const r of results) {
    if (!r.rows.length) lines.push(`| ${r.lane} | ${icon(r.outcome)} | | | | | ${r.note || ""} |`);
    for (const row of r.rows) {
      const stale = row.latest && row.resolved && row.latest !== row.resolved ? " (not latest)" : "";
      lines.push(
        `| ${r.lane} | ${icon(r.outcome)} | ${row.ecosystem} | \`${row.package}\` | ${row.resolved || "-"}${stale} | ${row.latest || "-"} | ${row.source} |`,
      );
    }
  }
  const notes = results.filter((r) => r.note && r.rows.length).map((r) => `- **${r.lane}**: ${r.note}`);
  if (notes.length) lines.push("", ...notes);
  return lines.join("\n") + "\n";
}

function emitMarkdown(md) {
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n");
  console.log(md);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}

module.exports = { parseRequirement, rewriteUvPyproject, rewritePoetryPyproject, LANES };

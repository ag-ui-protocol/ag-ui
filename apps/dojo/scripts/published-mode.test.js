// Unit tests for the manifest rewrites in published-mode.js (no network).
// Run: node --test apps/dojo/scripts/published-mode.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const {
  parseRequirement,
  rewriteUvPyproject,
  rewritePoetryPyproject,
  withMissingLanes,
  laneStatus,
  serverModules,
  LANES,
} = require("./published-mode.js");

const producers = (entries) => new Map(entries.map(([name, latest]) => [name, { name, latest }]));

test("parseRequirement splits name, extras, spec and marker", () => {
  assert.deepEqual(parseRequirement('ag2[ag-ui,openai]>=1.0.2,<2.0.0 ; python_version >= "3.11"'), {
    name: "ag2",
    extras: "[ag-ui,openai]",
    spec: ">=1.0.2,<2.0.0",
    marker: 'python_version >= "3.11"',
  });
  assert.equal(parseRequirement("ag_ui_adk").name, "ag_ui_adk");
});

test("uv: pins the producer, floats ag-ui-protocol and drops their path sources", () => {
  const input = [
    "[project]",
    'name = "x"',
    "dependencies = [",
    '    "agno[agui,google]>=3.0.4,<4",',
    '    "ag-ui-protocol>=0.1.22,<0.2",',
    '    "fastapi>=0.116.1",',
    "]",
    "",
    "[tool.uv.sources]",
    'ag-ui-protocol = { path = "../../../../sdks/python" }',
    'other = { path = "../other" }',
    "",
  ].join("\n");
  const out = rewriteUvPyproject(input, producers([["agno", "3.1.0"]]), new Set(["ag-ui-protocol"]));
  assert.match(out, /"agno\[agui,google\]>=3\.1\.0",/);
  assert.match(out, /"ag-ui-protocol",/);
  assert.match(out, /"fastapi>=0\.116\.1",/);
  assert.doesNotMatch(out, /sdks\/python/);
  assert.match(out, /other = \{ path = "\.\.\/other" \}/);
});

test("uv: normalises names (ag_ui_adk == ag-ui-adk) and adds a missing producer", () => {
  const input = ["[project]", 'dependencies = ["ag_ui_adk", "fastapi"]', "", "[tool.uv.sources]", 'ag_ui_adk = { path = "../", editable = true }', ""].join("\n");
  const out = rewriteUvPyproject(input, producers([["ag-ui-adk", "0.7.0"], ["ag-ui-protocol", "1.0.0"]]), new Set());
  assert.match(out, /"ag_ui_adk>=0\.7\.0"/);
  assert.match(out, /"ag-ui-protocol>=1\.0\.0"/);
  assert.doesNotMatch(out, /editable/);
});

test("uv: brackets in extras do not end the dependencies array early", () => {
  const input = ["[project]", "dependencies = [", '    "pydantic-ai-slim[openai,ag-ui]>=2,<3",', '    "dotenv"', "]", ""].join("\n");
  const out = rewriteUvPyproject(input, producers([["pydantic-ai-slim", "2.52.0"]]), new Set());
  assert.match(out, /"pydantic-ai-slim\[openai,ag-ui\]>=2\.52\.0"/);
  assert.match(out, /"dotenv"\n\]/);
});

test("poetry: swaps the path dependency for the PyPI release and floats toolkit", () => {
  const input = [
    "[tool.poetry.dependencies]",
    'python = "<3.15,>=3.10"',
    'ag-ui-a2ui-toolkit = ">=0.0.4"',
    'strands-agents = {extras = ["openai"], version = "^1.35.0"}',
    'ag_ui_strands = {path = "..", develop = true}',
    "",
    "[build-system]",
    "",
  ].join("\n");
  const out = rewritePoetryPyproject(input, producers([["ag-ui-strands", "0.4.1"]]), new Set(["ag-ui-a2ui-toolkit"]));
  assert.match(out, /^ag-ui-strands = ">=0\.4\.1"$/m);
  assert.match(out, /^ag-ui-a2ui-toolkit = "\*"$/m);
  assert.match(out, /strands-agents = \{extras = \["openai"\], version = "\^1\.35\.0"\}/);
  assert.doesNotMatch(out, /develop/);
});

test("lane table matches the dojo-e2e.yml matrix", () => {
  const workflow = fs.readFileSync(path.join(__dirname, "../../../.github/workflows/dojo-e2e.yml"), "utf8");
  const suites = [...workflow.matchAll(/^\s*- suite: ([\w-]+)\s*$/gm)].map((m) => m[1]);
  assert.ok(suites.length > 0);
  assert.deepEqual([...suites].sort(), Object.keys(LANES).sort());
});

test("summarize counts an expected lane with no report as failed", () => {
  const { results, failed } = withMissingLanes(
    [{ lane: "agno", outcome: "success", rows: [] }],
    ["agno", "mastra"],
  );
  assert.deepEqual(
    results.map((r) => [r.lane, r.outcome]),
    [
      ["agno", "success"],
      ["mastra", "missing"],
    ],
  );
  assert.deepEqual(failed.map((r) => r.lane), ["mastra"]);
});

test("a lane that passes on an older protocol is not counted as adoption", () => {
  const row = (pkg, resolved) => ({ package: pkg, resolved });
  const lane = (rows) => ({ lane: "pydantic-ai", outcome: "success", rows });
  assert.equal(laneStatus(lane([row("@ag-ui/client", "1.0.2"), row("ag-ui-protocol", "1.0.0")])), "adopted");
  assert.equal(laneStatus(lane([row("@ag-ui/client", "1.0.2"), row("ag-ui-protocol", "0.1.22")])), "older-protocol");
  assert.equal(laneStatus(lane([row("ag-ui-protocol", null)])), "older-protocol");
  assert.equal(laneStatus({ lane: "x", outcome: "failure", rows: [] }), "failed");

  const { failed } = withMissingLanes([lane([row("ag-ui-protocol", "0.1.22")])], ["pydantic-ai"]);
  assert.deepEqual(failed.map((r) => r.lane), ["pydantic-ai"]);
});

test("every Python lane names server modules that verify-sources can import", () => {
  const root = path.join(__dirname, "../../..");
  for (const [lane, def] of Object.entries(LANES)) {
    if (!def.python) continue;
    const modules = serverModules(root, def.python);
    assert.ok(modules.length > 0, lane);
    for (const serverModule of modules) {
      const base = path.join(root, def.python.dir, ...serverModule.split("."));
      assert.ok(
        fs.existsSync(`${base}.py`) || fs.existsSync(path.join(base, "__init__.py")),
        `${lane}: server module ${serverModule} not found in ${def.python.dir}`,
      );
    }
  }
});

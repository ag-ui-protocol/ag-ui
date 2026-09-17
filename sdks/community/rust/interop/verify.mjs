import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { verifyCases } from "../e2e/interop/assert-cases.mjs";

const directory = fileURLToPath(new URL("./", import.meta.url));
const rust = fileURLToPath(new URL("../", import.meta.url));
const source = fileURLToPath(new URL("../../../typescript/packages/core/src/index.ts", import.meta.url));

// Bundle the schemas from this checkout, resolving zod from the isolated harness.
// No published @ag-ui/core package can hide a change in the PR being reviewed.
const { outputFiles } = await build({
  entryPoints: [source],
  absWorkingDir: directory,
  nodePaths: [fileURLToPath(new URL("./node_modules", import.meta.url))],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
});
const {
  EventSchemas, EventType, RunAgentInputSchema, RunFinishedOutcomeSchema,
  SubagentFinishedOutcomeSchema,
} = await import(
  `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`
);

// These fixtures were transcribed from canonical schemas by the imported Rust
// wire tests. Executing the schemas here adds an independent semantic check.
const fixtures = JSON.parse(await readFile(new URL("./events.json", import.meta.url), "utf8"));
assert.deepEqual(
  [...new Set(fixtures.map((event) => event.type))].sort(),
  Object.values(EventType).sort(),
  "every current event variant needs a cross-language fixture",
);
const canonical = fixtures.map((event) => EventSchemas.parse(event));
const roundTrip = JSON.parse(execFileSync("cargo", [
  "run", "--locked", "--quiet", "-p", "ag-ui-migration-tests", "--example", "wire_round_trip",
], { cwd: rust, input: JSON.stringify(canonical), encoding: "utf8" }));
assert.deepEqual(roundTrip.map((event) => EventSchemas.parse(event)), canonical);
console.log(`${fixtures.length} event variants: TypeScript -> Rust -> TypeScript passed.`);

// Also compare rejection/normalization boundaries with the source in this PR,
// independently of the pinned published SDK tested by e2e/interop.
const cases = JSON.parse(await readFile(new URL("../e2e/interop/cases.json", import.meta.url), "utf8"));
const decoded = JSON.parse(execFileSync("cargo", [
  "run", "--locked", "--quiet", "-p", "ag-ui", "--example", "semantic_probe",
], { cwd: rust, input: JSON.stringify(cases), encoding: "utf8" }));
const differences = verifyCases(cases, decoded, {
  event: EventSchemas, input: RunAgentInputSchema, outcome: RunFinishedOutcomeSchema,
  subagentOutcome: SubagentFinishedOutcomeSchema,
});
console.log(`${cases.length} semantic cases against this checkout (${differences} documented representation differences).`);

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const directory = fileURLToPath(new URL("./", import.meta.url));
const rust = fileURLToPath(new URL("../", import.meta.url));
const source = fileURLToPath(new URL("../../../typescript/packages/core/src/schemas.ts", import.meta.url));

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
  EventSchemas, EventTypeSchema,
} = await import(
  `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`
);

// These fixtures were transcribed from canonical schemas by the imported Rust
// wire tests. Executing the schemas here adds an independent semantic check.
const fixtures = JSON.parse(await readFile(new URL("./events.json", import.meta.url), "utf8"));
const normativeTypes = new Set(EventTypeSchema.options);
const normative = fixtures.filter((event) => normativeTypes.has(event.type));
const legacy = fixtures.filter((event) => !normativeTypes.has(event.type));
assert.deepEqual(
  [...new Set(normative.map((event) => event.type))].sort(),
  EventTypeSchema.options.toSorted(),
  "every AG-UI 1.0 event variant needs a cross-language fixture",
);
assert.deepEqual(
  legacy.map((event) => event.type).sort(),
  ["THINKING_START", "THINKING_END", "THINKING_TEXT_MESSAGE_START", "THINKING_TEXT_MESSAGE_CONTENT", "THINKING_TEXT_MESSAGE_END"].sort(),
  "only the five retired thinking events may bypass the 1.0 TypeScript schema",
);
const canonical = normative.map((event) => EventSchemas.parse(event));
const roundTrip = JSON.parse(execFileSync("cargo", [
  "run", "--locked", "--quiet", "-p", "ag-ui-migration-tests", "--example", "wire_round_trip",
], { cwd: rust, input: JSON.stringify(canonical), encoding: "utf8" }));
assert.deepEqual(roundTrip.map((event) => EventSchemas.parse(event)), canonical);
console.log(`${normative.length} AG-UI 1.0 variants: TypeScript -> Rust -> TypeScript passed.`);

// The five retired variants remain readable by Rust's low-level wire codec.
// Client delivery translates them to REASONING_* before 1.0 enforcement.
const legacyRoundTrip = JSON.parse(execFileSync("cargo", [
  "run", "--locked", "--quiet", "-p", "ag-ui-migration-tests", "--example", "wire_round_trip",
], { cwd: rust, input: JSON.stringify(legacy), encoding: "utf8" }));
assert.deepEqual(legacyRoundTrip, legacy);
console.log(`${legacy.length} retired thinking variants: Rust compatibility codec passed.`);

import { verifyCases } from "./assert-cases.mjs";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  EventSchema, RunAgentInputSchema, RunFinishedOutcomeSchema,
  SubagentFinishedOutcomeSchema,
} from "@ag-ui/core/schemas";

const { version } = createRequire(import.meta.url)("@ag-ui/core/package.json");
const root = fileURLToPath(new URL("../../", import.meta.url));
const cases = JSON.parse(readFileSync(new URL("cases.json", import.meta.url), "utf8"));
const rust = JSON.parse(execFileSync("cargo", [
  "run", "--locked", "--quiet", "-p", "ag-ui", "--example", "semantic_probe",
], {cwd: root, input: JSON.stringify(cases), encoding: "utf8", stdio: ["pipe", "pipe", "inherit"]}));
const schemas = {
  event: EventSchema, input: RunAgentInputSchema, outcome: RunFinishedOutcomeSchema,
  subagentOutcome: SubagentFinishedOutcomeSchema,
};
const { verdicts, values } = verifyCases(cases, rust, schemas);
console.log(`PASS ${cases.length} cases against @ag-ui/core@${version} (${verdicts} documented acceptance differences, ${values} documented typed representation differences)`);

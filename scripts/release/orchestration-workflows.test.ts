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

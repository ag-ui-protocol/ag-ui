#!/usr/bin/env node
/**
 * Fails when a committed Python lockfile resolves ag-ui-protocol below 1.0.
 *
 * The Dojo runs each example from its lock, so a lock that drifts back to 0.x
 * quietly takes that lane off AG-UI 1.0 (PNI-537). Locks that have to stay on
 * 0.x are listed in PRE_1_0_LOCKS with the reason; an entry whose lock no
 * longer needs it fails too, so the list cannot outlive its reasons.
 *
 *   node apps/dojo/scripts/check-protocol-locks.js
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

/** Locks allowed to resolve ag-ui-protocol 0.x, and why. */
const PRE_1_0_LOCKS = {
  "integrations/langgraph/python/examples/uv.lock":
    "LangGraph Python keeps a deliberate ag-ui-protocol 0.x floor lane.",
  "integrations/microsoft-agent-framework/python/examples/uv.lock":
    "agent-framework-ag-ui pins ag-ui-protocol<0.2 upstream (PNI-514).",
  "integrations/pydantic-ai/python/examples/uv.lock":
    "pydantic-ai-slim pins ag-ui-protocol<1 upstream (PNI-564).",
};

const LOCK_FILE = /(^|\/)(uv|poetry)\.lock$/;

/** The ag-ui-protocol version a uv or Poetry lock resolves, or null. */
function lockedProtocolVersion(text) {
  const match = /\[\[package\]\]\r?\nname = "ag-ui-protocol"\r?\nversion = "([^"]+)"/.exec(text);
  return match ? match[1] : null;
}

const isPre1 = (version) => Number(version.split(".")[0]) < 1;

/**
 * Problems found in `locks` (path -> lock text) against `allowed`
 * (path -> reason). Locks that do not resolve ag-ui-protocol are ignored.
 */
function findProblems(locks, allowed = PRE_1_0_LOCKS) {
  const problems = [];
  for (const [file, text] of Object.entries(locks)) {
    const version = lockedProtocolVersion(text);
    if (version === null) continue;
    if (isPre1(version) && !(file in allowed)) {
      problems.push(`${file} resolves ag-ui-protocol ${version}; relock it on >=1.0`);
    }
    if (!isPre1(version) && file in allowed) {
      problems.push(
        `${file} resolves ag-ui-protocol ${version}; remove it from PRE_1_0_LOCKS in check-protocol-locks.js`,
      );
    }
  }
  for (const file of Object.keys(allowed)) {
    if (!(file in locks)) {
      problems.push(`${file} is listed in PRE_1_0_LOCKS but does not exist`);
    }
  }
  return problems;
}

function committedLocks(root) {
  const files = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter((file) => LOCK_FILE.test(file));
  return Object.fromEntries(
    files.map((file) => [file, fs.readFileSync(path.join(root, file), "utf8")]),
  );
}

if (require.main === module) {
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const problems = findProblems(committedLocks(root));
  if (problems.length) {
    console.error("Python locks off AG-UI 1.0:");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log("Every committed Python lock resolves ag-ui-protocol >=1.0 or is a listed exception.");
}

module.exports = { lockedProtocolVersion, findProblems, PRE_1_0_LOCKS };

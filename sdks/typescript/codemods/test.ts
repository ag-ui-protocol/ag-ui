/**
 * Smoke-test for the 0.1.0-schemas-to-subpath codemod.
 *
 * Runs the transform against the input fixture via jscodeshift subprocess and
 * diffs the result against the expected fixture. Exits 0 on success, 1 on mismatch.
 *
 * Usage:
 *   npx ts-node sdks/typescript/codemods/test.ts
 */
import { execFileSync } from "node:child_process";
import { readFileSync, copyFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const FIXTURES_DIR = join(__dirname, "__fixtures__");
const INPUT = join(FIXTURES_DIR, "0.1.0-schemas-to-subpath.input.ts");
const EXPECTED = join(FIXTURES_DIR, "0.1.0-schemas-to-subpath.expected.ts");
const CODEMOD = resolve(__dirname, "0.1.0-schemas-to-subpath.ts");

// Use os.tmpdir() so this works on Windows and Unix alike
const TMP_DIR = join(tmpdir(), "codemod-test");
mkdirSync(TMP_DIR, { recursive: true });
const TEMP = join(TMP_DIR, "codemod-test.ts");

copyFileSync(INPUT, TEMP);

// Use execFileSync (not exec/execSync) to avoid shell injection.
// On Windows, the binary is npx.cmd — execFileSync does not do PATHEXT resolution.
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
execFileSync(
  npx,
  ["--yes", "jscodeshift", "-t", CODEMOD, "--parser=tsx", TEMP],
  { stdio: "inherit" },
);

const actual = readFileSync(TEMP, "utf8");
const expected = readFileSync(EXPECTED, "utf8");

// Normalize line endings and trailing whitespace for comparison
const normalize = (s: string) => s.replace(/\r\n/g, "\n").trimEnd() + "\n";

if (normalize(actual) === normalize(expected)) {
  console.log("PASS — codemod output matches expected fixture.");
  process.exit(0);
} else {
  console.error("FAIL — codemod output differs from expected.");
  const actualLines = normalize(actual).split("\n");
  const expectedLines = normalize(expected).split("\n");
  const maxLines = Math.max(actualLines.length, expectedLines.length);
  for (let i = 0; i < maxLines; i++) {
    const a = actualLines[i] ?? "<missing>";
    const e = expectedLines[i] ?? "<missing>";
    if (a !== e) {
      console.error(`  Line ${i + 1}:`);
      console.error(`    expected: ${JSON.stringify(e)}`);
      console.error(`    actual:   ${JSON.stringify(a)}`);
    }
  }
  process.exit(1);
}

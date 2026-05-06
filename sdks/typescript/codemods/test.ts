/**
 * Smoke-test for the 0.1.0-schemas-to-subpath codemod.
 *
 * Runs the transform against the input fixture and diffs the result against
 * the expected fixture. Exits 0 on success, 1 on mismatch.
 *
 * Usage:
 *   npx ts-node sdks/typescript/codemods/test.ts
 *   # or, if ts-node is not available:
 *   npx jscodeshift --dry --print -t sdks/typescript/codemods/0.1.0-schemas-to-subpath.ts \
 *     sdks/typescript/codemods/__fixtures__/0.1.0-schemas-to-subpath.input.ts
 */
import * as fs from "fs";
import * as path from "path";
import { createTransformer } from "jscodeshift/src/testUtils";

const fixturesDir = path.join(__dirname, "__fixtures__");
const inputPath = path.join(fixturesDir, "0.1.0-schemas-to-subpath.input.ts");
const expectedPath = path.join(fixturesDir, "0.1.0-schemas-to-subpath.expected.ts");
const transformPath = path.join(__dirname, "0.1.0-schemas-to-subpath.ts");

// eslint-disable-next-line @typescript-eslint/no-var-requires
const transform = require(transformPath).default;

const input = fs.readFileSync(inputPath, "utf8");
const expected = fs.readFileSync(expectedPath, "utf8");

// jscodeshift's test utility runs the transform as the CLI would
const defineInlineTest = createTransformer(transform);

// Run the transform manually against the input source
import jscodeshift from "jscodeshift";
const jsWithParser = jscodeshift.withParser("tsx");

const result = transform({ source: input, path: inputPath }, { jscodeshift: jsWithParser, stats: () => {} }, {});

const actual = typeof result === "string" ? result : input;

// Normalize trailing newlines for comparison
const normalize = (s: string) => s.trimEnd() + "\n";

if (normalize(actual) === normalize(expected)) {
  console.log("✓  Codemod output matches expected fixture.");
  process.exit(0);
} else {
  console.error("✗  Codemod output does NOT match expected fixture.\n");
  // Simple unified-style diff
  const actualLines = actual.split("\n");
  const expectedLines = expected.split("\n");
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

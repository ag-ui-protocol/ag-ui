import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// The AG-UI version check runs in the shared page fixture
// (test-isolation-helper.ts, also reached through event-trace-test.ts). A spec
// that imports `test` straight from Playwright skips it without any sign, so
// its lane can pass while the producer never declares protocolVersion
// (PNI-590). Every spec goes through the shared fixture.

const e2eRoot = fileURLToPath(new URL("..", import.meta.url));
const testsDir = join(e2eRoot, "tests");

function specFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return specFiles(path);
    return entry.name.endsWith(".spec.ts") ? [path] : [];
  });
}

const PLAIN_PLAYWRIGHT_TEST =
  /import\s*\{[^}]*\btest\b[^}]*\}\s*from\s*["']@playwright\/test["']/;

test("every spec takes `test` from the shared fixture, not plain Playwright", () => {
  const bypassing = specFiles(testsDir)
    .filter((file) => PLAIN_PLAYWRIGHT_TEST.test(readFileSync(file, "utf8")))
    .map((file) => relative(e2eRoot, file));
  assert.deepEqual(
    bypassing,
    [],
    `import { test } from "../../test-isolation-helper" (or event-trace-test) instead:\n  ${bypassing.join("\n  ")}`,
  );
});

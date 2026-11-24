import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { version } from "../package.json";

test.each(["index.js", "index.mjs"])("reports the package version from built %s", (entry) => {
  const executable = fileURLToPath(new URL(`../dist/${entry}`, import.meta.url));
  const output = execFileSync(process.execPath, [executable, "--version"], {
    cwd: tmpdir(),
    encoding: "utf8",
  });

  expect(output.trim()).toBe(version);
});

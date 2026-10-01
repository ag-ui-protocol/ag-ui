import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pkg from "../package.json";

const require = createRequire(import.meta.url);

/**
 * Regression guard for PNI-540.
 *
 * In the workspace, `@ag-ui/client` resolves through a `workspace:*`
 * devDependency, so CI never exercises the floor declared in
 * `peerDependencies`. A consumer installing `@ag-ui/a2ui-middleware` from npm
 * resolves that floor instead — if it is lower than the version that actually
 * exports the symbols `src/` imports, the package fails at ESM load
 * ("does not provide an export named ...").
 *
 * `contentToText` (imported by src/index.ts) first ships in
 * `@ag-ui/client@1.0.0` (re-exported from `@ag-ui/core@1.0.0`), so the
 * declared floor must not admit anything older.
 */
const MIN_CLIENT = "1.0.0";

/** Minimum version admitted by a `>=x.y.z` range. */
function floorOf(range: string): string {
  const match = /^>=\s*(\d+\.\d+\.\d+)$/.exec(range.trim());
  if (!match) {
    throw new Error(
      `Expected a ">=x.y.z" peer range so the floor can be checked, got "${range}"`,
    );
  }
  return match[1];
}

function compare(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

function srcFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return srcFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

describe("peer dependency floors (PNI-540)", () => {
  it("declares an @ag-ui/client floor that exports every symbol src/ imports", () => {
    const range = pkg.peerDependencies["@ag-ui/client"];
    expect(compare(floorOf(range), MIN_CLIENT)).toBeGreaterThanOrEqual(0);
  });

  it("does not declare a floor above the workspace version under test", () => {
    // The floor must stay reachable: a floor newer than what the workspace
    // builds and tests against would be untested by CI.
    const clientVersion = require("@ag-ui/client/package.json").version;
    expect(
      compare(floorOf(pkg.peerDependencies["@ag-ui/client"]), clientVersion),
    ).toBeLessThanOrEqual(0);
  });

  it("only imports @ag-ui protocol packages that are declared as peers", () => {
    // `@ag-ui/core` is reached through `@ag-ui/client`'s re-exports. Importing
    // it directly would need its own peer entry and floor.
    const peers = Object.keys(pkg.peerDependencies);
    const srcDir = join(__dirname, "..", "src");
    const imported = new Set<string>();
    for (const file of srcFiles(srcDir)) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/from\s+["'](@ag-ui\/(?:client|core|encoder|proto))(?:\/[^"']*)?["']/g)) {
        imported.add(match[1]);
      }
    }
    expect([...imported].filter((name) => !peers.includes(name))).toEqual([]);
  });
});

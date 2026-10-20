import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(
  process.cwd(),
  "scripts/release/create-or-update-release.sh",
);
test("Maven release preserves committed Kotlin notes and Java records; retry is idempotent", () => {
  const root = mkdtempSync(join(tmpdir(), "kotlin-notes-"));
  try {
    mkdirSync(join(root, "scripts/release"), { recursive: true });
    mkdirSync(join(root, "bin"));
    const packages = ["core", "client", "tools"].map((module) => ({
      name: "kotlin-" + module,
      version: "0.4.2",
      path: "library/" + module,
      ecosystem: "maven",
      buildSystem: "gradle",
      groupId: "com.ag-ui.community",
    }));
    writeFileSync(
      join(root, "scripts/release/release.config.json"),
      JSON.stringify({
        scopes: {
          "sdk-kotlin": { versionSource: "library/build.gradle.kts", packages },
        },
      }),
    );
    for (const package_ of packages) {
      mkdirSync(join(root, package_.path), { recursive: true });
      writeFileSync(
        join(root, package_.path, "CHANGELOG.md"),
        "# Changelog\n\n## 0.4.2 — 2026-09-30\n\n- Approved **" +
          package_.name +
          "** behavior.\n\n### Breaking changes\n\nNone.\n\n## 0.4.1 — 2026-01-01\n\nOld notes.\n",
      );
    }
    const original =
      "### Java (Maven Central)\n\nExisting approved Java notes.\n<!-- ag-ui-published: java-core@0.1.0 -->\n";
    writeFileSync(join(root, "body"), original);
    writeFileSync(join(root, "calls"), "");
    writeFileSync(
      join(root, "bin/gh"),
      `#!/usr/bin/env bash
set -euo pipefail
if [ "$1 $2" = "release view" ]; then
  if [ "$#" -gt 3 ]; then cat "$FIXTURE_ROOT/body"; fi
elif [ "$1 $2" = "release edit" ]; then
  cat > "$FIXTURE_ROOT/body"
  echo edit >> "$FIXTURE_ROOT/calls"
else
  echo "Unexpected gh call" >&2; exit 1
fi
`,
      { mode: 0o755 },
    );
    const env = {
      ...process.env,
      PATH: join(root, "bin") + ":" + process.env.PATH,
      AGUI_RELEASE_REPO_ROOT: root,
      FIXTURE_ROOT: root,
      DRY_RUN: "false",
    };
    const run = () =>
      spawnSync("bash", [script, "maven", JSON.stringify(packages)], {
        env,
        encoding: "utf8",
      });
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    const body = readFileSync(join(root, "body"), "utf8");
    assert.ok(body.startsWith(original));
    assert.match(body, /### Maven Central - published/);
    for (const package_ of packages) {
      assert.ok(
        body.includes("- Approved **" + package_.name + "** behavior."),
      );
      assert.ok(body.includes("##### Breaking changes\n\nNone."));
      assert.equal(
        body.split("<!-- ag-ui-published: " + package_.name + "@0.4.2 -->")
          .length,
        2,
      );
    }
    assert.doesNotMatch(body, /Old notes/);
    const retry = run();
    assert.equal(retry.status, 0, retry.stderr);
    assert.equal(readFileSync(join(root, "body"), "utf8"), body);
    assert.equal(readFileSync(join(root, "calls"), "utf8"), "edit\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

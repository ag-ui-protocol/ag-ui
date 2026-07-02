import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";

const SCRIPT = join(process.cwd(), "scripts/release/prepare-release.ts");

async function runPrepareRelease(
  args: string[],
): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", ["--import", "tsx", SCRIPT, ...args], {
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => {
      stdout += c.toString();
    });
    child.stderr.on("data", (c) => {
      stderr += c.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      resolve({ status: code ?? 0, stdout, stderr });
    });
  });
}

test(
  "dry-run bumps sdk-dotnet shared VersionPrefix from Directory.Build.props",
  { timeout: 30_000 },
  async () => {
    const result = await runPrepareRelease([
      "--scope",
      "sdk-dotnet",
      "--bump",
      "minor",
      "--dry-run",
    ]);

    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    const output = JSON.parse(result.stdout);
    assert.equal(output.scope, "sdk-dotnet");
    assert.equal(output.packages.length, 6);
    assert.deepEqual(
      output.packages.map((pkg: { name: string }) => pkg.name),
      [
        "AGUI.Abstractions",
        "AGUI.Formatting",
        "AGUI.Protobuf",
        "AGUI.Client",
        "AGUI.Server",
        "AGUI",
      ],
    );
    for (const pkg of output.packages) {
      assert.equal(pkg.oldVersion, "0.0.1");
      assert.equal(pkg.newVersion, "0.1.0");
      assert.equal(pkg.file, "sdks/dotnet/Directory.Build.props");
      assert.equal(pkg.ecosystem, "dotnet");
    }
  },
);

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SCHEMA_PATH } from "../generator/generate";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Every published SDK package states the protocol version it implements.
 *
 * The version lives in one place — the version segment of the schema's `$id` —
 * and everything else quotes it: the generated constants, and the ten package
 * manifests checked here. A manifest is the one statement a consumer can read
 * without installing anything, off npm, PyPI or nuget.org, which is why it is
 * worth keeping and worth guarding: a manifest that disagrees with the schema
 * tells an integrator the package implements a version it does not.
 *
 * Nothing regenerates these, so nothing else would notice them going stale.
 */

const version = (() => {
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8")) as { $id: string };
  const match = /\/spec\/([^/]+)\/schema\.json$/.exec(schema.$id);
  if (!match) throw new Error(`cannot read a version out of "${schema.$id}"`);
  return match[1];
})();

const read = (...segments: string[]) =>
  readFileSync(join(REPO_ROOT, ...segments), "utf8");

describe("the protocol version each package states", () => {
  // The npm manifests carry it as a field of their own, which survives publish
  // and is readable with `npm view <pkg> agui`.
  it.each(["core", "client", "encoder", "proto"])(
    "@ag-ui/%s states it in package.json",
    (name) => {
      const manifest = JSON.parse(
        read("sdks", "typescript", "packages", name, "package.json"),
      ) as { agui?: { protocolVersion?: string } };
      expect(manifest.agui?.protocolVersion).toBe(version);
    },
  );

  // Python states it twice on purpose: the table is the statement in the repo,
  // and the keyword is what reaches the distribution metadata, since a wheel
  // does not carry pyproject.toml.
  it("ag-ui-protocol states it in pyproject.toml", () => {
    const pyproject = read("sdks", "python", "pyproject.toml");
    expect(pyproject).toContain(`protocol-version = "${version}"`);
    expect(pyproject).toContain(`"agui-protocol-${version}"`);
  });

  // The five AGUI.* packages share one props file. The property is the source;
  // the tag is what a consumer sees on nuget.org, which has no field for this.
  it("the AGUI.* packages state it in Directory.Build.props", () => {
    const props = read("sdks", "dotnet", "Directory.Build.props");
    expect(props).toContain(`<AGUIProtocolVersion>${version}</AGUIProtocolVersion>`);
    expect(props).toMatch(
      new RegExp(`<PackageTags>[^<]*agui-protocol-${version.replace(".", "\\.")}[^<]*</PackageTags>`),
    );
  });
});

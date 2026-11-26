import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  chmodSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("Java detector routes only POM Maven packages to XML and registry probes", () => {
  const root = mkdtempSync(join(tmpdir(), "java-detector-"));
  try {
    mkdirSync(join(root, "scripts/release"), { recursive: true });
    mkdirSync(join(root, "bin"));
    const real = join(
      process.cwd(),
      "scripts/release/detect-java-version-changes.sh",
    );
    writeFileSync(
      join(root, "scripts/release/detect-java-version-changes.sh"),
      readFileSync(real),
    );
    const config = JSON.parse(
      readFileSync("scripts/release/release.config.json", "utf8"),
    );
    writeFileSync(
      join(root, "scripts/release/release.config.json"),
      JSON.stringify(config),
    );
    for (const scope of Object.values(config.scopes) as any[])
      if (
        scope.packages.some(
          (p: any) => p.ecosystem === "maven" && p.buildSystem !== "gradle",
        )
      ) {
        mkdirSync(join(root, scope.versionSource, ".."), { recursive: true });
        writeFileSync(
          join(root, scope.versionSource),
          "<project><version>1.2.3</version></project>",
        );
      }
    const log = join(root, "calls.log");
    const stub = (name: string, text: string) => {
      const file = join(root, "bin", name);
      writeFileSync(file, text);
      chmodSync(file, 0o755);
    };
    stub("node", "#!/bin/sh\nexit 0\n");
    stub(
      "python3",
      `#!/bin/sh\nprintf 'python %s\\n' "$*" >> '${log}'\ncase "$*" in *gradle*) exit 95;; esac\nprintf '1.2.3\\n'\n`,
    );
    stub(
      "curl",
      `#!/bin/sh\nprintf 'curl %s\\n' "$*" >> '${log}'\nprintf '404'\n`,
    );
    const r = spawnSync(
      "bash",
      [join(root, "scripts/release/detect-java-version-changes.sh")],
      {
        encoding: "utf8",
        env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}` },
      },
    );
    assert.equal(r.status, 0, r.stderr);
    const packages = JSON.parse(r.stdout);
    const expected = Object.values(config.scopes)
      .flatMap((scope: any) => scope.packages)
      .filter((p: any) => p.ecosystem === "maven" && p.buildSystem !== "gradle")
      .map((p: any) => p.name);
    assert.deepEqual(
      packages.map((p: any) => p.name),
      expected,
    );
    assert.doesNotMatch(readFileSync(log, "utf8"), /kotlin|gradle/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const mode of [
  "unpublished",
  "older",
  "equal",
  "newer",
  "http-error",
  "bad-metadata",
  "computed",
  "missing",
  "unknown-selector",
]) {
  test(`Gradle detector uses Java metadata policy: ${mode}`, () => {
    const root = mkdtempSync(join(tmpdir(), "gradle-detector-"));
    try {
      mkdirSync(join(root, "scripts/release"), { recursive: true });
      mkdirSync(join(root, "bin"));
      for (const file of [
        "detect-java-version-changes.sh",
        "gradle-version.py",
        "release.config.json",
      ])
        writeFileSync(
          join(root, "scripts/release", file),
          readFileSync(`scripts/release/${file}`),
        );
      const config = JSON.parse(
        readFileSync("scripts/release/release.config.json", "utf8"),
      );
      const scope = config.scopes["sdk-kotlin"];
      mkdirSync(join(root, scope.versionSource, ".."), { recursive: true });
      if (mode !== "missing")
        writeFileSync(
          join(root, scope.versionSource),
          mode === "computed"
            ? 'version = providers.gradleProperty("version")\n'
            : 'version = "1.2.3"\nsubprojects { version = rootProject.version }\n',
        );
      const log = join(root, "calls.log");
      const curl = join(root, "bin/curl");
      const published =
        mode === "older" ? "1.2.2" : mode === "newer" ? "1.2.4" : "1.2.3";
      const body =
        mode === "bad-metadata"
          ? "bad xml"
          : `<metadata><versioning><versions><version>${published}</version></versions></versioning></metadata>`;
      writeFileSync(
        curl,
        `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nwhile [ "$#" -gt 0 ]; do\n if [ "$1" = -o ]; then shift; printf '%s' '${body}' > "$1"; fi\n shift\ndone\nprintf '${mode === "unpublished" ? "404" : mode === "http-error" ? "500" : "200"}'\n`,
      );
      chmodSync(curl, 0o755);
      const r = spawnSync(
        "bash",
        [
          join(root, "scripts/release/detect-java-version-changes.sh"),
          "--build-system",
          mode === "unknown-selector" ? "other" : "gradle",
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${root}/bin:${process.env.PATH}`,
            NODE_PATH: join(process.cwd(), "node_modules"),
          },
        },
      );
      if (
        [
          "http-error",
          "bad-metadata",
          "computed",
          "missing",
          "unknown-selector",
        ].includes(mode)
      ) {
        assert.notEqual(r.status, 0, r.stderr);
        assert.equal(r.stdout, "");
      } else {
        assert.equal(r.status, 0, r.stderr);
        assert.deepEqual(
          JSON.parse(r.stdout),
          ["unpublished", "older"].includes(mode)
            ? scope.packages.map((pkg: any) => ({
                name: pkg.name,
                version: "1.2.3",
                path: pkg.path,
                file: scope.versionSource,
                groupId: pkg.groupId,
              }))
            : [],
        );
        const calls = readFileSync(log, "utf8");
        assert.equal(calls.trim().split("\n").length, 3);
        assert.doesNotMatch(calls, /java-/);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

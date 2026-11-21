import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const SCRIPT = join(
  process.cwd(),
  "scripts/release/collect-accumulated-bumps.py",
);
const SOURCE = "sdks/community/kotlin/library/build.gradle.kts";
const KOTLIN = JSON.parse(
  readFileSync(
    join(process.cwd(), "scripts/release/release.config.json"),
    "utf8",
  ),
).scopes["sdk-kotlin"];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "collect-bumps-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" });
  const write = (file: string, text: string) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  };
  git("init", "-q", "--initial-branch=main");
  git("config", "user.email", "fixture@example.com");
  git("config", "user.name", "Fixture");
  git("config", "commit.gpgsign", "false");
  git("config", "tag.gpgSign", "false");
  write(
    "scripts/release/release.config.json",
    JSON.stringify({
      scopes: {
        "sdk-kotlin": KOTLIN,
        "sdk-typescript": {
          packages: [
            {
              name: "@ag-ui/core",
              path: "sdks/typescript/packages/core",
              ecosystem: "typescript",
            },
          ],
        },
        "sdk-java": {
          versionSource: "java/pom.xml",
          packages: [
            {
              name: "java-core",
              path: "java/core",
              ecosystem: "maven",
              groupId: "com.ag-ui.community",
            },
          ],
        },
        "sdk-dotnet": {
          versionSource: "dotnet/Directory.Build.props",
          packages: [
            { name: "AGUI.Core", path: "dotnet/core", ecosystem: "dotnet" },
          ],
        },
      },
    }),
  );
  const gradle = (v: string) =>
    `// version = "9.9.9"\r\nplugins { kotlin("multiplatform") version "2.1.20" }\r\nversion = "${v}" // release\r\nsubprojects { version = rootProject.version }\r\n`;
  write(SOURCE, gradle("0.4.1"));
  write(
    "sdks/typescript/packages/core/package.json",
    JSON.stringify({ name: "@ag-ui/core", version: "1.0.0" }),
  );
  write(
    "java/pom.xml",
    "<project><version>1.0.0</version><build><version>9.9.9</version></build></project>",
  );
  write(
    "dotnet/Directory.Build.props",
    "<Project><VersionPrefix>1.0.0</VersionPrefix></Project>",
  );
  const commit = () => {
    git("add", "-A");
    git("commit", "-qm", "fixture change");
  };
  commit();
  const base = git("rev-parse", "HEAD").trim();
  const collect = () =>
    spawnSync("python3", [SCRIPT, base, "HEAD"], {
      encoding: "utf8",
      env: { ...process.env, COLLECT_RELEASE_ROOT: root },
    });
  return { root, write, commit, collect, gradle };
}

for (const order of [["kotlin"], ["kotlin", "npm"], ["npm", "kotlin"]]) {
  test(`collector unions real git bumps in order ${order.join(" then ")}`, () => {
    const f = fixture();
    try {
      for (const scope of order) {
        if (scope === "kotlin") f.write(SOURCE, f.gradle("0.4.2"));
        else
          f.write(
            "sdks/typescript/packages/core/package.json",
            JSON.stringify({ name: "@ag-ui/core", version: "1.1.0" }),
          );
        f.commit();
      }
      const result = f.collect();
      assert.equal(result.status, 0, result.stderr);
      const bumps = JSON.parse(result.stdout);
      const kotlin = bumps.filter(
        (p: { scope: string }) => p.scope === "sdk-kotlin",
      );
      assert.deepEqual(
        kotlin.map((p: { name: string; newVersion: string }) => [
          p.name,
          p.newVersion,
        ]),
        [
          ["kotlin-core", "0.4.2"],
          ["kotlin-client", "0.4.2"],
          ["kotlin-tools", "0.4.2"],
        ],
      );
      for (const pkg of kotlin) {
        assert.equal(pkg.oldVersion, "0.4.1");
        assert.equal(pkg.file, SOURCE);
        assert.equal(pkg.buildSystem, "gradle");
        assert.equal(pkg.groupId, "com.ag-ui.community");
        assert.equal(pkg.ecosystem, "maven");
        assert.equal(
          pkg.path,
          KOTLIN.packages.find((p: { name: string }) => p.name === pkg.name)
            .path,
        );
      }
      assert.equal(bumps.length, order.includes("npm") ? 4 : 3);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
}

for (const kind of ["unchanged-root", "module-only", "unenrolled-kts"]) {
  test(`collector ignores ${kind} Kotlin edits`, () => {
    const f = fixture();
    try {
      if (kind === "unchanged-root")
        f.write(SOURCE, f.gradle("0.4.1") + "// documentation\r\n");
      else if (kind === "module-only")
        f.write(
          "sdks/community/kotlin/library/core/build.gradle.kts",
          'version = "3.2.1"\n',
        );
      else f.write("unrelated/build.gradle.kts", 'version = "3.2.1"\n');
      f.commit();
      const result = f.collect();
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), []);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
}

test("collector retains POM direct project versions and .NET shared-source bumps", () => {
  const f = fixture();
  try {
    f.write(
      "java/pom.xml",
      "<project><version>1.0.1</version><build><version>9.9.9</version></build></project>",
    );
    f.write(
      "dotnet/Directory.Build.props",
      "<Project><VersionPrefix>1.0.1</VersionPrefix></Project>",
    );
    f.commit();
    const result = f.collect();
    assert.equal(result.status, 0, result.stderr);
    const bumps = JSON.parse(result.stdout);
    assert.deepEqual(
      bumps
        .map((p: { name: string; newVersion: string }) => [
          p.name,
          p.newVersion,
        ])
        .sort(),
      [
        ["AGUI.Core", "1.0.1"],
        ["java-core", "1.0.1"],
      ],
    );
    assert.equal(
      bumps.find((p: { name: string }) => p.name === "java-core").groupId,
      "com.ag-ui.community",
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("collector rejects Gradle sources without a readable root version", () => {
  for (const source of ['version = providers.gradleProperty("version")']) {
    const f = fixture();
    try {
      f.write(SOURCE, source);
      f.commit();
      const result = f.collect();
      assert.notEqual(result.status, 0);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /version/);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }
});

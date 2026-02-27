import { releaseChangelog, releaseVersion } from "nx/release";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Programmatic release script for AG-UI monorepo.
 *
 * - Uses Nx Release to version and changelog TypeScript packages
 * - Handles Python pyproject.toml version bumps for Python packages
 * - Designed to run in CI as part of the release PR workflow
 */

// Python package name -> relative path from repo root
const PYTHON_PACKAGES: Record<string, string> = {
  "ag-ui-protocol": "sdks/python",
  "ag-ui-langgraph": "integrations/langgraph/python",
  "ag-ui-crewai": "integrations/crew-ai/python",
  "ag_ui_adk": "integrations/adk-middleware/python",
  "ag-ui-agent-spec": "integrations/agent-spec/python",
  "ag_ui_strands": "integrations/aws-strands/python",
};

const VERSION_PLANS_DIR = path.join(process.cwd(), ".nx", "version-plans");

function parseArgs(): { dryRun: boolean; verbose: boolean } {
  const args = process.argv.slice(2);
  return {
    dryRun: !args.includes("--dry-run=false"),
    verbose: args.includes("--verbose"),
  };
}

function bumpSemver(
  current: string,
  bump: string
): string {
  const parts = current.split(".").map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) {
    throw new Error(`Invalid semver: ${current}`);
  }
  const [major, minor, patch] = parts;

  switch (bump) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
    default:
      throw new Error(`Unknown bump type: ${bump}`);
  }
}

interface PythonBump {
  packageName: string;
  packageDir: string;
  bump: string;
}

function parsePythonBumpsFromVersionPlans(): PythonBump[] {
  const bumps: PythonBump[] = [];

  if (!fs.existsSync(VERSION_PLANS_DIR)) {
    return bumps;
  }

  const files = fs
    .readdirSync(VERSION_PLANS_DIR)
    .filter((f) => f.endsWith(".md") && f !== ".gitkeep");

  for (const file of files) {
    const content = fs.readFileSync(
      path.join(VERSION_PLANS_DIR, file),
      "utf-8"
    );

    // Parse YAML front matter
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) continue;

    const frontMatter = match[1];
    for (const line of frontMatter.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      // Parse "key: value" or '"key": value'
      const kvMatch = trimmed.match(/^"?([^":\s]+)"?\s*:\s*(.+)$/);
      if (!kvMatch) continue;

      const [, key, value] = kvMatch;
      const packageDir = PYTHON_PACKAGES[key];
      if (packageDir) {
        bumps.push({
          packageName: key,
          packageDir,
          bump: value.trim(),
        });
      }
    }
  }

  return bumps;
}

function bumpPythonVersions(
  bumps: PythonBump[],
  dryRun: boolean,
  verbose: boolean
): void {
  for (const { packageName, packageDir, bump } of bumps) {
    const pyprojectPath = path.join(process.cwd(), packageDir, "pyproject.toml");

    if (!fs.existsSync(pyprojectPath)) {
      console.warn(
        `Warning: pyproject.toml not found at ${pyprojectPath}, skipping ${packageName}`
      );
      continue;
    }

    const content = fs.readFileSync(pyprojectPath, "utf-8");
    const versionMatch = content.match(/^version\s*=\s*"([^"]+)"/m);

    if (!versionMatch) {
      console.warn(
        `Warning: Could not find version in ${pyprojectPath}, skipping ${packageName}`
      );
      continue;
    }

    const currentVersion = versionMatch[1];
    const newVersion = bumpSemver(currentVersion, bump);

    console.log(
      `Python: ${packageName} ${currentVersion} -> ${newVersion} (${bump})`
    );

    if (!dryRun) {
      const updated = content.replace(
        /^(version\s*=\s*")([^"]+)(")/m,
        `$1${newVersion}$3`
      );
      fs.writeFileSync(pyprojectPath, updated, "utf-8");
    }

    if (verbose) {
      console.log(`  Path: ${pyprojectPath}`);
    }
  }
}

async function main(): Promise<void> {
  const { dryRun, verbose } = parseArgs();

  if (dryRun) {
    console.log("Running in dry-run mode (pass --dry-run=false to apply)\n");
  }

  // Step 1: Handle Python version bumps from version plan files
  const pythonBumps = parsePythonBumpsFromVersionPlans();
  if (pythonBumps.length > 0) {
    console.log("=== Python Package Versions ===\n");
    bumpPythonVersions(pythonBumps, dryRun, verbose);
    console.log();
  }

  // Step 2: Run Nx Release versioning for TypeScript packages
  console.log("=== TypeScript Package Versions ===\n");
  const { workspaceVersion, projectsVersionData } = await releaseVersion({
    dryRun,
    verbose,
  });

  // Step 3: Generate changelogs
  console.log("\n=== Changelogs ===\n");
  await releaseChangelog({
    versionData: projectsVersionData,
    version: workspaceVersion,
    dryRun,
    verbose,
  });

  if (dryRun) {
    console.log("\nDry run complete. No files were modified.");
  } else {
    console.log("\nRelease versioning and changelog generation complete.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

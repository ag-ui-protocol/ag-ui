#!/usr/bin/env npx tsx
/**
 * generate-release-notes.ts
 *
 * Generates release notes from git history for a given release scope.
 *
 * Usage:
 *   npx tsx scripts/release/generate-release-notes.ts --scope <scope>
 *
 * For each package in the scope, finds the most recent git tag, collects
 * commits since that tag that touched the package's directory, and outputs
 * categorized markdown.
 */

import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(): { scope: string } {
  const args = process.argv.slice(2);
  let scope: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--scope") {
      scope = args[++i];
    }
  }

  if (!scope) {
    console.error("Usage: generate-release-notes.ts --scope <scope>");
    process.exit(1);
  }

  return { scope };
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface PackageConfig {
  name: string;
  path: string;
  ecosystem: "typescript" | "python";
  buildSystem?: string;
}

interface ScopeConfig {
  description: string;
  sharedVersion: boolean;
  versionSource?: string;
  packages: PackageConfig[];
}

interface ReleaseConfig {
  scopes: Record<string, ScopeConfig>;
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

function exec(cmd: string): string {
  return execSync(cmd, { encoding: "utf-8" }).trim();
}

function execSafe(cmd: string): string {
  try {
    return execSync(cmd, { encoding: "utf-8" }).trim();
  } catch {
    return "";
  }
}

/**
 * Find the most recent tag for a package.
 * Tags follow the format: <name>@<version> (e.g., @ag-ui/core@0.0.52 or ag-ui-langgraph@0.0.32)
 */
function findLatestTag(packageName: string): string | null {
  // List tags matching the package name pattern, sorted by creation date
  const tags = execSafe(`git tag --list "${packageName}@*" --sort=-creatordate`);
  if (!tags) return null;
  return tags.split("\n")[0] || null;
}

/**
 * Get commits since a tag (or last 50 commits if no tag) that touch given paths.
 */
function getCommits(
  sinceTag: string | null,
  paths: string[]
): Array<{ hash: string; subject: string; body: string }> {
  const pathArgs = paths.map((p) => `-- "${p}"`).join(" ");
  const rangeArg = sinceTag ? `${sinceTag}..HEAD` : "-50";
  const recordSep = "---COMMIT-SEP---";
  const fieldSep = "%x00";
  const format = `${fieldSep}%H${fieldSep}%s${fieldSep}%b${recordSep}`;

  const raw = exec(
    `git log ${rangeArg} --format="${format}" ${pathArgs}`
  );

  if (!raw) return [];

  const commits: Array<{ hash: string; subject: string; body: string }> = [];
  const records = raw.split(recordSep).filter(Boolean);

  for (const record of records) {
    const fields = record.split("\x00").filter(Boolean);
    if (fields.length < 2) continue;
    commits.push({
      hash: fields[0].trim(),
      subject: fields[1].trim(),
      body: (fields[2] || "").trim(),
    });
  }

  return commits;
}

// ---------------------------------------------------------------------------
// Commit categorization
// ---------------------------------------------------------------------------

interface CategorizedCommit {
  hash: string;
  subject: string;
  category: string;
}

function categorizeCommit(subject: string, hash: string): CategorizedCommit {
  const lower = subject.toLowerCase();

  // Match conventional commit prefixes
  const prefixMatch = subject.match(/^(feat|fix|docs|style|refactor|perf|test|chore|ci|build|revert)(\(.+?\))?!?:\s*/);
  if (prefixMatch) {
    const type = prefixMatch[1];
    const cleanSubject = subject.slice(prefixMatch[0].length);
    const categoryMap: Record<string, string> = {
      feat: "Features",
      fix: "Bug Fixes",
      docs: "Documentation",
      perf: "Performance",
      refactor: "Refactoring",
      revert: "Reverts",
      test: "Tests",
      chore: "Other",
      ci: "Other",
      build: "Other",
      style: "Other",
    };

    return {
      hash,
      subject: cleanSubject || subject,
      category: categoryMap[type] || "Other",
    };
  }

  // Heuristic fallback
  if (lower.startsWith("fix") || lower.includes("bugfix")) {
    return { hash, subject, category: "Bug Fixes" };
  }
  if (lower.startsWith("add") || lower.startsWith("implement") || lower.includes("feature")) {
    return { hash, subject, category: "Features" };
  }

  return { hash, subject, category: "Other" };
}

// ---------------------------------------------------------------------------
// Markdown generation
// ---------------------------------------------------------------------------

function generateMarkdown(commits: CategorizedCommit[]): string {
  if (commits.length === 0) {
    return "No changes since last release.\n";
  }

  const categories: Record<string, CategorizedCommit[]> = {};
  for (const commit of commits) {
    if (!categories[commit.category]) {
      categories[commit.category] = [];
    }
    categories[commit.category].push(commit);
  }

  // Order: Features, Bug Fixes, Performance, then everything else
  const orderedKeys = [
    "Features",
    "Bug Fixes",
    "Performance",
    "Documentation",
    "Refactoring",
    "Reverts",
    "Tests",
    "Other",
  ].filter((k) => categories[k]);

  let md = "## What's Changed\n\n";

  for (const category of orderedKeys) {
    const items = categories[category];
    if (!items || items.length === 0) continue;

    md += `### ${category}\n\n`;
    for (const item of items) {
      const shortHash = item.hash.slice(0, 7);
      md += `- ${item.subject} (${shortHash})\n`;
    }
    md += "\n";
  }

  return md;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const { scope } = parseArgs();
  const repoRoot = path.resolve(__dirname, "../..");

  const configPath = path.join(repoRoot, "scripts/release/release.config.json");
  const config: ReleaseConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));

  const scopeConfig = config.scopes[scope];
  if (!scopeConfig) {
    console.error(`Unknown scope: "${scope}"`);
    process.exit(1);
  }

  // Collect all package paths and find the oldest common tag
  const allPaths: string[] = [];
  let oldestTag: string | null = null;

  for (const pkg of scopeConfig.packages) {
    allPaths.push(pkg.path);

    const tag = findLatestTag(pkg.name);
    if (tag) {
      console.error(`Found tag for ${pkg.name}: ${tag}`);
      // Use the oldest tag as the baseline (most conservative)
      if (!oldestTag) {
        oldestTag = tag;
      } else {
        // Compare tag dates
        const existingDate = exec(`git log -1 --format=%ct ${oldestTag}`);
        const newDate = exec(`git log -1 --format=%ct ${tag}`);
        const existingTs = parseInt(existingDate, 10);
        const newTs = parseInt(newDate, 10);
        if (!isNaN(newTs) && (isNaN(existingTs) || newTs < existingTs)) {
          oldestTag = tag;
        }
      }
    } else {
      console.error(`No tag found for ${pkg.name}, will use last 50 commits`);
    }
  }

  // Collect commits
  const commits = getCommits(oldestTag, allPaths);

  // Deduplicate by hash
  const seen = new Set<string>();
  const unique = commits.filter((c) => {
    if (seen.has(c.hash)) return false;
    seen.add(c.hash);
    return true;
  });

  console.error(`Found ${unique.length} commits since ${oldestTag || "start"}`);

  // Categorize
  const categorized = unique.map((c) => categorizeCommit(c.subject, c.hash));

  // Generate markdown
  const markdown = generateMarkdown(categorized);

  // Output to stdout
  console.log(markdown);
}

main();

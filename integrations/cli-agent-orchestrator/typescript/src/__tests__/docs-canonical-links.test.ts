// F-SL4 recurrence guard: shipped docs must reference the canonical awslabs
// repo, never the plauzy/ fork. Mirrors the repo norm of pairing a content-bug
// fix (P0-3) with a mechanical guard so it cannot silently regress.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function markdownFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...markdownFiles(full));
    else if (entry.endsWith(".md")) out.push(full);
  }
  return out;
}

// GitHub host names are case-insensitive, and a repository is also written in
// the SSH form (git@github.com:owner/repo.git), so match both separators.
const hasPlauzyLink = (text: string): boolean =>
  /github\.com[/:]plauzy\//i.test(text);

describe("shipped docs canonical links", () => {
  it("the matcher ignores host case and still accepts the awslabs link", () => {
    expect(
      hasPlauzyLink("https://github.com/plauzy/cli-agent-orchestrator"),
    ).toBe(true);
    expect(
      hasPlauzyLink("https://GITHUB.COM/plauzy/cli-agent-orchestrator"),
    ).toBe(true);
    expect(
      hasPlauzyLink("https://github.com/awslabs/cli-agent-orchestrator"),
    ).toBe(false);
  });

  it("the matcher catches the SSH fork form too, and not the awslabs one", () => {
    expect(
      hasPlauzyLink("git@github.com:plauzy/cli-agent-orchestrator.git"),
    ).toBe(true);
    expect(
      hasPlauzyLink("git@GITHUB.COM:plauzy/cli-agent-orchestrator.git"),
    ).toBe(true);
    expect(
      hasPlauzyLink("git@github.com:awslabs/cli-agent-orchestrator.git"),
    ).toBe(false);
  });

  it("contain no plauzy/ GitHub URLs", () => {
    const offenders: string[] = [];
    for (const file of markdownFiles(packageRoot)) {
      const text = readFileSync(file, "utf8");
      if (hasPlauzyLink(text)) offenders.push(file);
    }
    expect(offenders, `plauzy/ URLs found in: ${offenders.join(", ")}`).toEqual(
      [],
    );
  });
});

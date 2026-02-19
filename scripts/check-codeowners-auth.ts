import fs from "node:fs";

interface CodeownersRule {
  pattern: string;
  owners: string[];
}

const actor = process.env.ACTOR;
const pkg = process.env.PACKAGE;
const githubToken = process.env.GITHUB_TOKEN;

if (!actor || !pkg) {
  console.error("ERROR: ACTOR and PACKAGE environment variables are required");
  process.exit(1);
}

async function isTeamMember(
  org: string,
  teamSlug: string,
  username: string
): Promise<boolean> {
  if (!githubToken) {
    console.warn(
      `WARN: No GITHUB_TOKEN set, cannot resolve team membership for ${org}/${teamSlug}`
    );
    return false;
  }
  const url = `https://api.github.com/orgs/${org}/teams/${teamSlug}/members/${username}`;
  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${githubToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  // 204 = is a member, 404 = not a member
  return resp.status === 204;
}

async function isAuthorizedByOwners(
  owners: string[],
  username: string
): Promise<boolean> {
  for (const owner of owners) {
    if (owner.includes("/")) {
      // org/team reference
      const [org, teamSlug] = owner.split("/", 2);
      if (await isTeamMember(org, teamSlug, username)) {
        return true;
      }
    } else {
      // individual user
      if (owner === username) {
        return true;
      }
    }
  }
  return false;
}

// Parse CODEOWNERS
const lines = fs.readFileSync(".github/CODEOWNERS", "utf-8").split("\n");
const rules: CodeownersRule[] = [];
let rootOwners: string[] = [];

for (const line of lines) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const parts = trimmed.split(/\s+/);
  const pattern = parts[0];
  const owners = parts.slice(1).map((o) => o.replace("@", ""));
  if (pattern === "*") {
    rootOwners = owners;
  } else {
    rules.push({ pattern, owners });
  }
}

// Find the most specific matching rule for this package path
// Strip trailing /python to match CODEOWNERS entries like "integrations/adk-middleware"
const pathsToCheck = [pkg];
const pythonSuffix = "/python";
if (pkg.endsWith(pythonSuffix)) {
  pathsToCheck.push(pkg.slice(0, -pythonSuffix.length));
}

let matchedRule: CodeownersRule | null = null;

for (const checkPath of pathsToCheck) {
  for (const rule of rules) {
    const pattern = rule.pattern.replace(/\/$/, "");
    if (checkPath === pattern || checkPath.startsWith(pattern + "/")) {
      matchedRule = rule;
      break;
    }
  }
  if (matchedRule) break;
}

// Fall back to root owners if no specific rule matched
if (!matchedRule) {
  matchedRule = { pattern: "*", owners: rootOwners };
}

isAuthorizedByOwners(matchedRule.owners, actor).then((authorized) => {
  console.log(`Actor:          ${actor}`);
  console.log(`Package:        ${pkg}`);
  console.log(
    `Matched rule:   ${matchedRule!.pattern} -> ${matchedRule!.owners.join(", ")}`
  );
  console.log(`Authorized:     ${authorized}`);

  if (!authorized) {
    console.error(`\nERROR: ${actor} is not a CODEOWNERS owner for ${pkg}`);
    console.error(`Allowed users: ${matchedRule!.owners.join(", ")}`);
    process.exit(1);
  }
});

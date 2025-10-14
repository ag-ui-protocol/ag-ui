#!/usr/bin/env node

const { execSync } = require("child_process");
const path = require("path");
const concurrently = require("concurrently");

// Parse command line arguments
const args = process.argv.slice(2);
const showHelp = args.includes("--help") || args.includes("-h");
const dryRun = args.includes("--dry-run");

// selection controls
function parseList(flag) {
  const idx = args.indexOf(flag);
  if (idx !== -1 && args[idx + 1]) {
    return args[idx + 1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return null;
}

const onlyList = parseList("--only") || parseList("--include");
const excludeList = parseList("--exclude") || [];

if (showHelp) {
  console.log(`
Usage: node prep-dojo-everything.js [options]

Options:
  --dry-run       Show what would be installed without actually running
  --only list     Comma-separated services to include (defaults to all)
  --exclude list  Comma-separated services to exclude
  --help, -h      Show this help message

Examples:
  node prep-dojo-everything.js
  node prep-dojo-everything.js --dry-run
  node prep-dojo-everything.js --only dojo,agno
  node prep-dojo-everything.js --exclude crew-ai,mastra
`);
  process.exit(0);
}

const gitRoot = execSync("git rev-parse --show-toplevel", { encoding: "utf-8" }).trim();
const integrationsRoot = path.join(gitRoot, "integrations");
const middlewaresRoot = path.join(gitRoot, "middlewares");

// Define all prep targets keyed by a stable id
const ALL_TARGETS = {
  "server-starter": {
    command: "poetry install",
    name: "Server Starter",
    cwd: path.join(integrationsRoot, "server-starter/python/examples"),
  },
  "server-starter-all": {
    command: "poetry install",
    name: "Server AF",
    cwd: path.join(integrationsRoot, "server-starter-all-features/python/examples"),
  },
  agno: {
    command: "uv sync",
    name: "Agno",
    cwd: path.join(integrationsRoot, "agno/python/examples"),
  },
  "crew-ai": {
    command: "poetry install",
    name: "CrewAI",
    cwd: path.join(integrationsRoot, "crew-ai/python"),
  },
  "langgraph-fastapi": {
    command: "poetry install",
    name: "LG FastAPI",
    cwd: path.join(integrationsRoot, "langgraph/python/examples"),
    env: {
      POETRY_VIRTUALENVS_IN_PROJECT: "false",
    },
  },
  "langgraph-platform-typescript": {
    command: "pnpm install",
    name: "LG Platform TS",
    cwd: path.join(integrationsRoot, "langgraph/typescript/examples"),
  },
  "llama-index": {
    command: "uv sync",
    name: "Llama Index",
    cwd: path.join(integrationsRoot, "llama-index/python/examples"),
  },
  mastra: {
    command: "pnpm install --no-frozen-lockfile",
    name: "Mastra",
    cwd: path.join(integrationsRoot, "mastra/typescript/examples"),
  },
  "pydantic-ai": {
    command: "uv sync",
    name: "Pydantic AI",
    cwd: path.join(integrationsRoot, "pydantic-ai/python/examples"),
  },
  "adk-middleware": {
    command: "uv sync",
    name: "ADK Middleware",
    cwd: path.join(integrationsRoot, "adk-middleware/python/examples"),
  },
  "a2a-middleware": {
    command: "uv sync",
    name: "A2A Middleware",
    cwd: path.join(middlewaresRoot, "a2a-middleware/examples"),
  },
  dojo: {
    command: "pnpm install --no-frozen-lockfile && pnpm build --filter=demo-viewer...",
    name: "Dojo",
    cwd: gitRoot,
  },
};

function printDryRunServices(procs) {
  console.log("Dry run - would install dependencies for the following services:");
  procs.forEach((proc) => {
    console.log(`  - ${proc.name} (${proc.cwd})`);
    console.log(`    Command: ${proc.command}`);
    console.log("");
  });
  process.exit(0);
}

async function main() {
  // determine selection
  let selectedKeys = Object.keys(ALL_TARGETS);
  if (onlyList && onlyList.length) {
    selectedKeys = onlyList;
  }
  if (excludeList && excludeList.length) {
    selectedKeys = selectedKeys.filter((k) => !excludeList.includes(k));
  }

  // Build procs list, warning on unknown keys
  const procs = [];
  for (const key of selectedKeys) {
    const target = ALL_TARGETS[key];
    if (!target) {
      console.warn(`Skipping unknown service: ${key}`);
      continue;
    }
    procs.push(target);
  }

  if (dryRun) {
    printDryRunServices(procs);
  }

  const { result } = concurrently(procs);

  result
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

main();

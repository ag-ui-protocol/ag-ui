#!/usr/bin/env node

const { execSync } = require("child_process");
const path = require("path");
const concurrently = require("concurrently");

// Parse command line arguments
const args = process.argv.slice(2);
const showHelp = args.includes("--help") || args.includes("-h");
const dryRun = args.includes("--dry-run");

if (showHelp) {
  console.log(`
Usage: node run-dojo.js [options]

Options:
  --dry-run       Show what would be started without actually running
  --help, -h      Show this help message

Examples:
  node run-dojo.js
  node run-dojo.js --dry-run
`);
  process.exit(0);
}

const gitRoot = execSync("git rev-parse --show-toplevel", { encoding: "utf-8" }).trim();

// THE ACTUAL DOJO
const dojo = {
  command: "pnpm run start",
  name: "Dojo",
  cwd: path.join(gitRoot, "apps/dojo"),
  env: {
    PORT: 9000,
    NEXT_PUBLIC_COPILOTKIT_RUNTIME_URL: process.env.NEXT_PUBLIC_COPILOTKIT_RUNTIME_URL,
    NEXT_PUBLIC_AGNO_COPILOT_API_KEY: process.env.NEXT_PUBLIC_AGNO_COPILOT_API_KEY,
    NEXT_PUBLIC_CREWAI_COPILOT_API_KEY: process.env.NEXT_PUBLIC_CREWAI_COPILOT_API_KEY,
    NEXT_PUBLIC_LANGGRAPH_COPILOT_API_KEY: process.env.NEXT_PUBLIC_LANGGRAPH_COPILOT_API_KEY,
    NEXT_PUBLIC_LANGGRAPH_FASTAPI_COPILOT_API_KEY:
      process.env.NEXT_PUBLIC_LANGGRAPH_FASTAPI_COPILOT_API_KEY,
    NEXT_PUBLIC_LANGGRAPH_TYPESCRIPT_COPILOT_API_KEY:
      process.env.NEXT_PUBLIC_LANGGRAPH_TYPESCRIPT_COPILOT_API_KEY,
    NEXT_PUBLIC_LLAMA_INDEX_COPILOT_API_KEY: process.env.NEXT_PUBLIC_LLAMA_INDEX_COPILOT_API_KEY,
    NEXT_PUBLIC_MASTRA_COPILOT_API_KEY: process.env.NEXT_PUBLIC_MASTRA_COPILOT_API_KEY,
    NEXT_PUBLIC_PYDANTIC_AI_COPILOT_API_KEY: process.env.NEXT_PUBLIC_PYDANTIC_AI_COPILOT_API_KEY,
  },
};

const procs = [dojo];

function printDryRunServices(procs) {
  console.log("Dry run - would start the following services:");
  procs.forEach((proc) => {
    console.log(`  - ${proc.name} (${proc.cwd})`);
    console.log(`    Command: ${proc.command}`);
    console.log(`    Environment variables:`);
    if (proc.env) {
      Object.entries(proc.env).forEach(([key, value]) => {
        console.log(`      ${key}: ${value}`);
      });
    } else {
      console.log("      No environment variables specified.");
    }
    console.log("");
  });
  process.exit(0);
}

async function main() {
  if (dryRun) {
    printDryRunServices(procs);
  }

  console.log("Starting services: ", procs.map((p) => p.name).join(", "));

  const { result } = concurrently(procs, { killOthersOn: ["failure", "success"] });

  result
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

main();

#!/usr/bin/env node

const { execSync } = require('child_process');
const path = require('path');
const concurrently = require('concurrently');

// Parse command line arguments
const args = process.argv.slice(2);
const showHelp = args.includes('--help') || args.includes('-h');
const dryRun = args.includes('--dry-run');

if (showHelp) {
  console.log(`
Usage: node prep-dojo-everything.js [options]

Options:
  --dry-run       Show what would be installed without actually running
  --help, -h      Show this help message

Examples:
  node prep-dojo-everything.js
  node prep-dojo-everything.js --dry-run
`);
  process.exit(0);
}

const gitRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf-8' }).trim();
const integrationsRoot = path.join(gitRoot, 'typescript-sdk', 'integrations');



// Server Starter
const serverStarter = {
  command: 'poetry install',
  name: 'Server Starter',
  cwd: path.join(integrationsRoot, 'server-starter/server/python'),
}

// Server Starter All Features
const serverStarterAllFeatures = {
  command: 'poetry install',
  name: 'Server AF',
  cwd: path.join(integrationsRoot, 'server-starter-all-features/server/python'),
}

// Agno
const agno = {
  command: 'uv venv --allow-existing && uv pip install -r requirements.txt',
  name: 'Agno',
  cwd: path.join(integrationsRoot, 'agno/examples'),
}

// CrewAI
const crewai = {
  command: 'poetry install',
  name: 'CrewAI',
  cwd: path.join(integrationsRoot, 'crewai/python'),
}

// Langgraph (FastAPI)
const langgraphFastapi = {
  command: 'poetry install',
  name: 'LG FastAPI',
  cwd: path.join(integrationsRoot, 'langgraph/python/ag_ui_langgraph/examples'),
}

// Langgraph (Platorm {typescript})
const langgraphPlatformTypescript = {
  command: 'pnpm install',
  name: 'LG Platform TS',
  cwd: path.join(integrationsRoot, 'langgraph/examples/typescript/'),
}

// Llama Index
const llamaIndex = {
  command: 'uv sync',
  name: 'Llama Index',
  cwd: path.join(integrationsRoot, 'llamaindex/server-py'),
}

// Mastra
const mastra = {
  command: 'npm install',
  name: 'Mastra',
  cwd: path.join(integrationsRoot, 'mastra/example'),
}

// Pydantic AI
const pydanticAi = {
  command: 'uv sync',
  name: 'Pydantic AI',
  cwd: path.join(integrationsRoot, 'pydantic-ai/examples'),
}

// THE ACTUAL DOJO
const dojo = {
  command: 'pnpm install --no-frozen-lockfile && pnpm build --filter=demo-viewer...',
  name: 'Dojo',
  cwd: path.join(gitRoot, 'typescript-sdk'),
}

function printDryRunServices(procs) {
  console.log('Dry run - would install dependencies for the following services:');
  procs.forEach(proc => {
    console.log(`  - ${proc.name} (${proc.cwd})`);
    console.log(`    Command: ${proc.command}`);
    console.log('');
  });
  process.exit(0);
}

async function main() {
  const procs = [
    serverStarter,
    serverStarterAllFeatures,
    agno,
    crewai,
    // langgraphFastapi, // Disabled until build fixes
    langgraphPlatformTypescript,
    llamaIndex,
    mastra,
    pydanticAi,
    dojo
  ];

  if (dryRun) {
    printDryRunServices(procs);
  }

  const {result} = concurrently(procs);

  result.then(() => process.exit(0)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

main();

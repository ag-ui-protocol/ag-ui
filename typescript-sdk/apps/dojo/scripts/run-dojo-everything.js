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
Usage: node run-dojo-everything.js [options]

Options:
  --dry-run       Show what would be started without actually running
  --help, -h      Show this help message

Examples:
  node run-dojo-everything.js
  node run-dojo-everything.js --dry-run
`);
  process.exit(0);
}

const gitRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf-8' }).trim();
const integrationsRoot = path.join(gitRoot, 'typescript-sdk', 'integrations');

// Server Starter
const serverStarter = {
  command: 'poetry run dev',
  name: 'Server Starter',
  cwd: path.join(integrationsRoot, 'server-starter/server/python'),
  env: {PORT: 8000},
}

// Server Starter All Features
const serverStarterAllFeatures = {
  command: 'poetry run dev',
  name: 'Server AF',
  cwd: path.join(integrationsRoot, 'server-starter-all-features/server/python'),
  env: {PORT: 8001},
}

// Agno
const agno = {
  command: 'uv run dev',
  name: 'Agno',
  cwd: path.join(integrationsRoot, 'agno/examples'),
  env: {PORT: 8002},
}

// CrewAI
const crewai = {
  command: 'poetry run dev',
  name: 'CrewAI',
  cwd: path.join(integrationsRoot, 'crewai/python'),
  env: {PORT: 8003},
}

// Langgraph (FastAPI)
const langgraphFastapi = {
  command: 'poetry run dev',
  name: 'LG FastAPI',
  cwd: path.join(integrationsRoot, 'langgraph/examples/python'),
  env: {PORT: 8004},
}

// Langgraph (Platform {python})
const langgraphPlatformPython = {
  command: 'pnpx @langchain/langgraph-cli@latest dev --no-browser --port 8005',
  name: 'LG Platform Py',
  cwd: path.join(integrationsRoot, 'langgraph/examples/python'),
  env: {PORT: 8005},
}

// Langgraph (Platform {typescript})
const langgraphPlatformTypescript = {
  command: 'pnpx @langchain/langgraph-cli@latest dev --no-browser --port 8006',
  name: 'LG Platform TS',
  cwd: path.join(integrationsRoot, 'langgraph/examples/typescript/'),
  env: {PORT: 8006},
}

// Llama Index
const llamaIndex = {
  command: 'uv run dev',
  name: 'Llama Index',
  cwd: path.join(integrationsRoot, 'llamaindex/server-py'),
  env: {PORT: 8007},
}

// Mastra
const mastra = {
  command: 'npm run dev',
  name: 'Mastra',
  cwd: path.join(integrationsRoot, 'mastra/example'),
  env: {PORT: 8008},
}

// Pydantic AI
const pydanticAi = {
  command: 'uv run dev',
  name: 'Pydantic AI',
  cwd: path.join(integrationsRoot, 'pydantic-ai/examples'),
  env: {PORT: 8009},
}

// THE ACTUAL DOJO
const dojo = {
  command: 'pnpm run start',
  name: 'Dojo',
  cwd: path.join(gitRoot, 'typescript-sdk/apps/dojo'),
  env: {
    PORT: 9999,
    SERVER_STARTER_URL: 'http://localhost:8000',
    SERVER_STARTER_ALL_FEATURES_URL: 'http://localhost:8001',
    AGNO_URL: 'http://localhost:8002',
    CREW_AI_URL: 'http://localhost:8003',
    LANGGRAPH_FAST_API_URL: 'http://localhost:8004',
    LANGGRAPH_PYTHON_URL: 'http://localhost:8005',
    LANGGRAPH_TYPESCRIPT_URL: 'http://localhost:8006',
    LLAMA_INDEX_URL: 'http://localhost:8007',
    MASTRA_URL: 'http://localhost:8008',
    PYDANTIC_AI_URL: 'http://localhost:8009',
    NEXT_PUBLIC_CUSTOM_DOMAIN_TITLE: 'cpkdojo.local___CopilotKit Feature Viewer',
  }
}

const procs = [
  serverStarter,
  serverStarterAllFeatures,
  agno,
  crewai,
  langgraphFastapi,
  langgraphPlatformPython,
  langgraphPlatformTypescript,
  llamaIndex,
  mastra,
  pydanticAi,
  dojo
];

function printDryRunServices(procs) {
  console.log('Dry run - would start the following services:');
  procs.forEach(proc => {
    console.log(`  - ${proc.name} (${proc.cwd})`);
    console.log(`    Command: ${proc.command}`);
    console.log(`    Environment variables:`);
    if (proc.env) {
      Object.entries(proc.env).forEach(([key, value]) => {
        console.log(`      ${key}: ${value}`);
      });
    } else {
      console.log('      No environment variables specified.');
    }
    console.log('');
  });
  process.exit(0);
}

async function main() {
  if (dryRun) {
    printDryRunServices(procs);
  }

  console.log('Starting services: ', procs.map(p => p.name).join(', '));

  const {result} = concurrently(procs, {killOthersOn: ['failure', 'success']});

  result.then(() => process.exit(0)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

main();

#!/usr/bin/env node

const { execSync } = require('child_process');
const path = require('path');
const concurrently = require('concurrently');

// Parse command line arguments
const args = process.argv.slice(2);
const showHelp = args.includes('--help') || args.includes('-h');
const dryRun = args.includes('--dry-run');

function parseList(flag) {
  const idx = args.indexOf(flag);
  if (idx !== -1 && args[idx + 1]) {
    return args[idx + 1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return null;
}

const onlyList = parseList('--only') || parseList('--include');
const excludeList = parseList('--exclude') || [];

if (showHelp) {
  console.log(`
Usage: node run-dojo-everything.js [options]

Options:
  --dry-run       Show what would be started without actually running
  --only list     Comma-separated services to include (defaults to all)
  --exclude list  Comma-separated services to exclude
  --help, -h      Show this help message

Examples:
  node run-dojo-everything.js
  node run-dojo-everything.js --dry-run
  node run-dojo-everything.js --only dojo,server-starter
  node run-dojo-everything.js --exclude crew-ai,mastra
`);
  process.exit(0);
}

const gitRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf-8' }).trim();
const integrationsRoot = path.join(gitRoot, 'integrations');
const middlewaresRoot = path.join(gitRoot, 'middlewares');

// Define all runnable services keyed by a stable id
const ALL_SERVICES = {
  'server-starter': [{
    command: 'poetry run dev',
    name: 'Server Starter',
    cwd: path.join(integrationsRoot, 'server-starter/python/examples'),
    env: { PORT: 8000 },
  }],
  'server-starter-all': [{
    command: 'poetry run dev',
    name: 'Server AF',
    cwd: path.join(integrationsRoot, 'server-starter-all-features/python/examples'),
    env: { PORT: 8001 },
  }],
  'agno': [{
    command: 'uv run dev',
    name: 'Agno',
    cwd: path.join(integrationsRoot, 'agno/python/examples'),
    env: { PORT: 8002 },
  }],
  'crew-ai': [{
    command: 'poetry run dev',
    name: 'CrewAI',
    cwd: path.join(integrationsRoot, 'crew-ai/python'),
    env: { PORT: 8003 },
  }],
  'langgraph-fastapi': [{
    command: 'poetry run dev',
    name: 'LG FastAPI',
    cwd: path.join(integrationsRoot, 'langgraph/python/examples'),
    env: {
      PORT: 8004,
      POETRY_VIRTUALENVS_IN_PROJECT: 'false',
    },
  }],
  'langgraph-platform-python': [{
    command: 'pnpx @langchain/langgraph-cli@latest dev --no-browser --host 127.0.0.1 --port 8005',
    name: 'LG Platform Py',
    cwd: path.join(integrationsRoot, 'langgraph/python/examples'),
    env: { PORT: 8005 },
  }],
  'langgraph-platform-typescript': [{
    command: 'pnpx @langchain/langgraph-cli@latest dev --no-browser --host 127.0.0.1 --port 8006',
    name: 'LG Platform TS',
    cwd: path.join(integrationsRoot, 'langgraph/typescript/examples'),
    env: { PORT: 8006 },
  }],
  'llama-index': [{
    command: 'uv run dev',
    name: 'Llama Index',
    cwd: path.join(integrationsRoot, 'llama-index/python/examples'),
    env: { PORT: 8007 },
  }],
  'mastra': [{
    command: 'npm run dev',
    name: 'Mastra',
    cwd: path.join(integrationsRoot, 'mastra/typescript/examples'),
    env: { PORT: 8008 },
  }],
  'pydantic-ai': [{
    command: 'uv run dev',
    name: 'Pydantic AI',
    cwd: path.join(integrationsRoot, 'pydantic-ai/python/examples'),
    env: { PORT: 8009 },
  }],
  'adk-middleware': [{
    command: 'uv run dev',
    name: 'ADK Middleware',
    cwd: path.join(integrationsRoot, 'adk-middleware/python/examples'),
    env: { PORT: 8010 },
  }],
  'a2a-middleware': [{
    command: 'uv run buildings_management.py',
    name: 'A2A Middleware: Buildings Management',
    cwd: path.join(middlewaresRoot, "a2a-middleware/examples"),
    env: { PORT: 8011 },
  },
  {
    command: 'uv run finance.py',
    name: 'A2A Middleware: Finance',
    cwd: path.join(middlewaresRoot, "a2a-middleware/examples"),
    env: { PORT: 8012 },
  },
  {
    command: 'uv run it.py',
    name: 'A2A Middleware: IT',
    cwd: path.join(middlewaresRoot, "a2a-middleware/examples"),
    env: { PORT: 8013 },
  },
  {
    command: 'uv run orchestrator.py',
    name: 'A2A Middleware: Orchestrator',
    cwd: path.join(middlewaresRoot, "a2a-middleware/examples"),
    env: { PORT: 8014 },
  }],
  'dojo': [{
    command: 'pnpm run start',
    name: 'Dojo',
    cwd: path.join(gitRoot, 'apps/dojo'),
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
      ADK_MIDDLEWARE_URL: 'http://localhost:8010',
      A2A_MIDDLEWARE_BUILDINGS_MANAGEMENT_URL: 'http://localhost:8011',
      A2A_MIDDLEWARE_FINANCE_URL: 'http://localhost:8012',
      A2A_MIDDLEWARE_IT_URL: 'http://localhost:8013',
      A2A_MIDDLEWARE_ORCHESTRATOR_URL: 'http://localhost:8014',
      NEXT_PUBLIC_CUSTOM_DOMAIN_TITLE: 'cpkdojo.local___CopilotKit Feature Viewer',
    },
  }],
};

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
  // determine selection
  let selectedKeys = Object.keys(ALL_SERVICES);
  if (onlyList && onlyList.length) {
    selectedKeys = onlyList;
  }
  if (excludeList && excludeList.length) {
    selectedKeys = selectedKeys.filter((k) => !excludeList.includes(k));
  }

  // Build processes, warn for unknown keys
  const procs = [];
  for (const key of selectedKeys) {
    const svcs = ALL_SERVICES[key];
    if (!svcs || svcs.length === 0) {
      console.warn(`Skipping unknown service: ${key}`);
      continue;
    }
    procs.push(...svcs);
  }

  if (dryRun) {
    printDryRunServices(procs);
  }

  console.log('Starting services: ', procs.map((p) => p.name).join(', '));

  const { result } = concurrently(procs, { killOthersOn: ['failure', 'success'] });

  result
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

main();

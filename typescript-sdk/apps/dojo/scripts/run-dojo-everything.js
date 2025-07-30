#!/usr/bin/env node

const { execSync } = require('child_process');
const path = require('path');
const concurrently = require('concurrently');

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
  command: 'uv run agent.py',
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
  cwd: path.join(integrationsRoot, 'langgraph/python/ag_ui_langgraph/examples'),
  env: {PORT: 8004},
}

// Langgraph (Platform)
const langgraph = {
  command: 'pnpx @langchain/langgraph-cli@latest dev --no-browser --port 8005',
  name: 'LG Platform',
  cwd: path.join(integrationsRoot, 'langgraph/examples'),
  env: {PORT: 8005},
}

// Llama Index
const llamaIndex = {
  command: 'uv run dev',
  name: 'Llama Index',
  cwd: path.join(integrationsRoot, 'llamaindex/server-py'),
  env: {PORT: 8006},
}

// Mastra
const mastra = {
  command: 'npm run dev',
  name: 'Mastra',
  cwd: path.join(integrationsRoot, 'mastra/example'),
  env: {PORT: 8007},
}

// Pydantic AI
const pydanticAi = {
  command: 'uv run dev',
  name: 'Pydantic AI',
  cwd: path.join(integrationsRoot, 'pydantic-ai/examples'),
  env: {PORT: 8008},
}

// THE ACTUAL DOJO
const dojo = {
  command: 'pnpm run dev',
  name: 'Dojo',
  cwd: path.join(gitRoot, 'typescript-sdk/apps/dojo'),
  env: {
    SERVER_STARTER_URL: 'http://localhost:8000',
    SERVER_STARTER_ALL_FEATURES_URL: 'http://localhost:8001',
    AGNO_URL: 'http://localhost:8002',
    CREW_AI_URL: 'http://localhost:8003',
    LANGGRAPH_FAST_API_URL: 'http://localhost:8004',
    LANGGRAPH_URL: 'http://localhost:8005',
    LLAMA_INDEX_URL: 'http://localhost:8006',
    MASTRA_URL: 'http://localhost:8007',
    PYDANTIC_AI_URL: 'http://localhost:8008',
  }
}

async function main() {
  const {result} = concurrently([
    serverStarter,
    serverStarterAllFeatures,
    agno,
    crewai,
    langgraphFastapi,
    langgraph,
    llamaIndex,
    mastra,
    pydanticAi,
    dojo,
  ]);

  result.then(() => process.exit(0)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

main();

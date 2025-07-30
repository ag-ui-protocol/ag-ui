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
}

// Server Starter All Features
const serverStarterAllFeatures = {
  command: 'poetry run dev',
  name: 'Server AF',
  cwd: path.join(integrationsRoot, 'server-starter-all-features/server/python'),
}

// Agno
const agno = {
  command: 'uv run agent.py',
  name: 'Agno',
  cwd: path.join(integrationsRoot, 'agno/examples'),
}

// CrewAI
const crewai = {
  command: 'poetry run dev',
  name: 'CrewAI',
  cwd: path.join(integrationsRoot, 'crewai/python'),
}

// Langgraph (FastAPI)
const langgraphFastapi = {
  command: 'poetry run dev',
  name: 'LG FastAPI',
  cwd: path.join(integrationsRoot, 'langgraph/python/ag_ui_langgraph/examples'),
}

// Langgraph (Platform)
const langgraph = {
  command: 'pnpx @langchain/langgraph-cli@latest dev --no-browser',
  name: 'LG Platform',
  cwd: path.join(integrationsRoot, 'langgraph/examples'),
}

// Llama Index
const llamaIndex = {
  command: 'uv run dev',
  name: 'Llama Index',
  cwd: path.join(integrationsRoot, 'llamaindex/server-py'),
}

// Mastra
const mastra = {
  command: 'npm run dev',
  name: 'Mastra',
  cwd: path.join(integrationsRoot, 'mastra/example'),
}

// Pydantic AI
const pydanticAi = {
  command: 'uv run dev',
  name: 'Pydantic AI',
  cwd: path.join(integrationsRoot, 'pydantic-ai/examples'),
}

// THE ACTUAL DOJO
const dojo = {
  command: 'pnpm run dev',
  name: 'Dojo',
  cwd: path.join(gitRoot, 'typescript-sdk/apps/dojo'),
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

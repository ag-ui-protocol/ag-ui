# A2UI Dojo — Local Development Setup

This guide sets up the A2UI demos in the ag-ui dojo, running locally with three repos linked together.

## Prerequisites

- **Node.js** (v20+)
- **pnpm** (v10+)
- **Python** (3.12+)
- **uv** (Python package manager) — install via `curl -LsSf https://astral.sh/uv/install.sh | sh`
- **OpenAI API key** — set `OPENAI_API_KEY` in your environment

## Directory Structure

All three repos must be cloned as siblings:

```
a2ui-demo/
├── ag-ui/        # ag-ui protocol + dojo app
├── CopilotKit/   # CopilotKit framework
└── A2UI/         # A2UI renderer (web_core + react)
```

## Setup

### 1. Clone repos

```bash
mkdir a2ui-demo && cd a2ui-demo
git clone https://github.com/ag-ui-protocol/ag-ui.git ag-ui
git clone https://github.com/CopilotKit/CopilotKit.git CopilotKit
git clone <a2ui-repo-url> A2UI
```

### 2. Check out branches

```bash
cd ag-ui && git checkout lukasmoschitz/a2ui-v0.9 && cd ..
cd CopilotKit && git checkout lukasmoschitz/a2ui-v0.9 && cd ..
cd A2UI && git checkout react-1 && cd ..
```

### 3. Install dependencies

```bash
cd A2UI/renderers/web_core && npm install && cd ../../..
cd A2UI/renderers/react && npm install && cd ../../..
cd CopilotKit && pnpm install && cd ..
cd ag-ui && pnpm install
```

### 4. Build and link everything

From the ag-ui root:

```bash
cd apps/dojo
npm run local-install
```

This single command:
- Builds A2UI renderer packages (web_core, react)
- Links A2UI into CopilotKit and builds CopilotKit packages
- Links CopilotKit and A2UI into the ag-ui workspace
- Builds all ag-ui SDK and middleware packages
- Syncs the middleware into CopilotKit's dependency store
- Creates a Python venv and installs the CopilotKit Python SDK

## Running

Open two terminals from the ag-ui root:

**Terminal 1 — Python agent:**

```bash
cd integrations/langgraph/python/examples
source .venv/bin/activate
uvicorn agents.dojo:app --port 8000
```

**Terminal 2 — Dojo frontend:**

```bash
cd apps/dojo
npm run dev
```

Open http://localhost:3000 in your browser.

## A2UI Demos

Select **LangGraph (FastAPI)** from the integration dropdown, then choose:

| Demo | Description |
|------|-------------|
| **A2UI Fixed Schema** | Pre-defined flight/hotel search cards (no streaming) |
| **A2UI Fixed Schema (Streaming)** | Flight search with progressive streaming rendering |
| **A2UI Dynamic Schema** | LLM-generated UI from conversation context |
| **A2UI Advanced** | Dynamic UI with custom progress renderer and action handlers |

## Reverting to npm packages

To revert from local links back to npm versions:

```bash
cd ag-ui
pnpm install  # without COPILOTKIT_LOCAL or A2UI_LOCAL env vars
```

## Troubleshooting

**"Module not found" errors in browser:**
Clear the Next.js cache and restart:
```bash
rm -rf apps/dojo/.next apps/dojo/.turbopack
cd apps/dojo && npm run dev
```

**Python agent not starting:**
Ensure the venv exists and has dependencies:
```bash
cd integrations/langgraph/python/examples
uv venv && uv sync
source .venv/bin/activate
uvicorn agents.dojo:app --port 8000
```

**Dynamic A2UI renders empty cards:**
The LLM may generate incorrect path formats. Retry the prompt — the system instructs the LLM to use relative paths inside List templates.

# Open Agent Spec AG-UI Examples
================================

This directory contains example usage of the AG-UI integration for Open Agent Spec (Agent Spec). It provides a FastAPI application that demonstrates how to use the Agent Spec agent with the AG-UI protocol.

## Features

The examples include implementations for each of the AG-UI dojo features:

* Agentic Chat
* Human in the Loop
* Agentic Generative UI
* Tool Based Generative UI

## Setup

1. Please see the README in the parent folder for instructions on which GitHub repos to clone.

2. Install dependencies (choose runtimes via extras):
   ```bash
   # Both runtimes
   uv sync --extra langgraph --extra wayflow
   # Or pick one runtime
   # uv sync --extra langgraph
   # uv sync --extra wayflow
   ```

3. Run the development server:
   ```bash
   uv run dev
   ```

Note: Routers are lazy-loaded. If you do not install a runtime extra (e.g., `langgraph`), its corresponding endpoints will not work, resulting in a HTTP 404 error when invoking from Dojo.

### Environment (.env)

The example server loads a `.env` file on startup (via `python-dotenv`). Place it in this folder to configure your environment.

Common variables:
- `PORT`: the HTTP port for the example FastAPI server (default `9003`).
- `OPENAI_BASE_URL`: OpenAI‑compatible API base (e.g., `https://api.openai.com/v1`).
- `OPENAI_MODEL`: model id (e.g., `gpt-4o` or provider‑specific ids).
- `OPENAI_API_KEY`: API key for your provider.

Example `.env`:
```
PORT=9003
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o
OPENAI_API_KEY=sk-...
```

## Usage

Once the server is running, launch the frontend Dojo:

```bash
# Option A — run everything from repo root (multiple apps)
cd ../../../
pnpm install
pnpm dev

# Option B — run only Dojo
cd ag-ui/apps/dojo
AGENT_SPEC_URL=http://localhost:9003 pnpm run dev
```

Then open http://localhost:3000.

By default, the agents can be reached at:

- `http://localhost:9003/<runtime>/agentic_chat` - Agentic Chat
- `http://localhost:9003/<runtime>/agentic_generative_ui` - Agentic Generative UI
- `http://localhost:9003/<runtime>/human_in_the_loop` - Human in the Loop
- `http://localhost:9003/<runtime>/tool_based_generative_ui` - Tool Based Generative UI

where `<runtime>` is a runtime supported by Agent Spec, currently `langgraph` and `wayflow`.

# assistant-ui Example

A React chat built with [assistant-ui](https://www.assistant-ui.com) and its AG-UI runtime, `@assistant-ui/react-ag-ui`. The same frontend runs against two AG-UI agents, one built with Pydantic AI and one with Agno, which serve the same tools.

## Features

- Streaming text
- A backend tool (`get_weather`) rendered as a card
- A frontend tool (`change_background`) that runs in the browser
- Human-in-the-loop: `approve_plan` waits for the user to pick which steps to keep
- Shared state: a task list that the agent and the user can both edit
- A switch between the Pydantic AI and Agno agents

## Prerequisites

- Node.js 22.12 or later and pnpm
- [uv](https://docs.astral.sh/uv/)
- An OpenAI or Anthropic API key

This app is not part of the repository's pnpm workspace. It installs the published `@assistant-ui/*` and `@ag-ui/client` packages on its own, because `@assistant-ui/react` needs zod 4 while the workspace overrides zod to 3.

## Setup

1. Start the agents. Both read `MODEL` (default `openai:gpt-4.1-mini`) and the matching provider key:

   ```bash
   cd agents
   uv sync
   export OPENAI_API_KEY=your_api_key_here
   # or: export ANTHROPIC_API_KEY=... MODEL=anthropic:claude-haiku-5-5

   uv run pydantic_ai_agent.py   # http://localhost:8105/
   uv run agno_agent.py          # http://localhost:8115/agui (in a second terminal)
   ```

   Either port can be changed with `PORT`.

2. Start the frontend from this directory:

   ```bash
   pnpm install
   pnpm dev
   ```

   Open http://localhost:5173. To point it at other agents, copy `.env.example` to `.env` and change the URLs.

Try these prompts:

- "What's the weather in Lisbon?"
- "Make the background a soft green"
- "Plan a weekend trip to Lisbon", then approve some of the steps
- Tick a task in the side panel, then ask "Which tasks have I finished?"

## How It Works

- **`src/App.tsx`**: creates an `HttpAgent` for the selected agent and passes it to `useAgUiRuntime`
- **`src/tools.tsx`**: a toolkit with a `backend` renderer, a `frontend` tool and a `human` tool. Frontend and human tools are sent to the agent in each run's `tools`; when the agent calls one, the run ends and the result goes back on the next run
- **`src/TaskPanel.tsx`**: reads agent state with `useAgUiState` and edits it with `useAgUiSetState`. Edits are sent as `state` on the next run
- **`src/Thread.tsx`**: the chat UI, built from assistant-ui primitives
- **`agents/`**: the Pydantic AI agent uses `AGUIAdapter`, and the Agno agent uses AgentOS with the `AGUI` interface

See the [assistant-ui quickstart](https://docs.ag-ui.com/integrations/assistant-ui) for the same steps in an existing app.

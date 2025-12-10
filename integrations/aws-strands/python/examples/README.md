# AWS Strands Example Server

Demo FastAPI server that wires the Strands Agents SDK (Gemini models) into the
AG-UI protocol. Each route mounts a ready-made agent that showcases different UI
patterns (vanilla chat, backend tool rendering, shared state, and generative UI).

## Requirements

- Python 3.12 or 3.13 (the project is pinned to `<3.14`)
- Poetry 1.8+ (ships with the repo via `curl -sSL https://install.python-poetry.org | python3 -`)
- Google API key with access to Gemini 2.5 Flash (set as `GOOGLE_API_KEY`)
- (Optional) AG-UI repo running locally so you can point the Dojo at these routes

## Quick start

```bash
cd integrations/aws-strands/python/examples

# pick a supported interpreter if your global default is 3.14
poetry env use python3.13

poetry install
```

Create a `.env` file in this folder (same dir as `pyproject.toml`) so every
example can load credentials automatically:

```bash
GOOGLE_API_KEY=your-gemini-key
# Optional overrides
PORT=8000                 # FastAPI listen port
```

> The sample agents default to `gemini-2.5-flash` and already set sensible
> temperature/token parameters; override only if you need a different tier.

## Running the demo server

Either command exposes all mounted apps on `http://localhost:${PORT:-8000}`:

```bash
poetry run dev          # uses the Poetry script entry point (server:main)
# or
poetry run python -m server
```

The root route lists the available demos:

| Route | Description |
| --- | --- |
| `/agentic-chat` | Simple chat agent with a frontend-only `change_background` tool |
| `/backend-tool-rendering` | Backend-executed tools (charts, faux weather) rendered in AG-UI |
| `/agentic-generative-ui` | Demonstrates `PredictState` + delta streaming for plan tracking |
| `/shared-state` | Recipe builder showing shared JSON state + tool arguments |

Point the AG-UI Dojo (or any AG-UI client) at these SSE endpoints to see the
Strands wrapper translate Gemini events into protocol-native messages.

## Environment reference

| Variable | Required | Purpose |
| --- | --- | --- |
| `GOOGLE_API_KEY` | Yes | Auth for the Gemini SDK (`strands.models.gemini.GeminiModel`) |
| `PORT` | No | Overrides the default `8000` uvicorn port |

All OpenTelemetry exporters are disabled by default in code (`OTEL_SDK_DISABLED`
and `OTEL_PYTHON_DISABLED_INSTRUMENTATIONS`), so you do not need to set those
manually.

## How it works

- Each `server/api/*.py` file constructs a Strands `Agent`, registers any tools,
  and wraps it with `ag_ui_strands.StrandsAgent`.
- `server/__init__.py` mounts the four FastAPI apps under a single router and
  exposes the `main()` entrypoint that `poetry run dev` calls.
- The project depends on `ag_ui_strands` via a path dependency (`..`) so you can
  develop the integration and server side-by-side without publishing a wheel.
- Want a different Gemini tier? Update the `model_id` argument in the agent
  definitions inside `server/api/*.py`.




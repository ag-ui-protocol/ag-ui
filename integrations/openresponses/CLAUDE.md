# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

### TypeScript Package
```bash
# From integrations/openresponses/typescript/

# Install dependencies (from monorepo root)
pnpm install

# Build the package
pnpm build

# Build in watch mode
pnpm dev

# Type checking
pnpm typecheck

# Run tests
pnpm test

# Clean build artifacts
pnpm clean
```

### Python Package
```bash
# From integrations/openresponses/python/

# Install dependencies
pip install -e .

# Or with dev dependencies
pip install -e ".[dev]"

# Run tests
pytest

# Type checking
mypy src/
```

### Python Examples
```bash
# From integrations/openresponses/python/examples/

# Install dependencies
poetry install

# Run the example server
poetry run python -m example_server
```

## Architecture

### Overview

The openresponses integration provides an AG-UI agent that connects to any OpenResponses-compatible endpoint. It supports:

- **OpenAI** (`https://api.openai.com/v1`)
- **Azure OpenAI** (`https://{resource}.openai.azure.com`)
- **Hugging Face** (`https://api-inference.huggingface.co/v1`)
- **Moltbot** (`http://localhost:18789`) - with agent routing

### Python Package (`python/src/ag_ui_openresponses/`)

The main implementation with full OpenResponses protocol support:

```
ag_ui_openresponses/
├── agent.py              # Main OpenResponsesAgent class
├── endpoint.py           # FastAPI endpoint factory
├── types.py              # Type definitions (configs, API types, events)
├── providers/
│   └── base.py           # Provider detection and defaults
├── request/
│   └── request_builder.py # AG-UI → OpenResponses translation
├── response/
│   ├── sse_parser.py     # SSE stream parsing
│   ├── event_translator.py # OpenResponses → AG-UI events
│   └── tool_call_handler.py # Tool call state tracking
└── utils/
    └── http_client.py    # aiohttp wrapper with retries
```

**Key features:**
- Provider auto-detection from base URL
- Stateful mode via `previous_response_id` (transparent to client)
- Multimodal content support (images, files)
- Tool call handling with proper event sequencing
- Moltbot agent routing via model field or headers

### TypeScript Package (`typescript/`)

A minimal `HttpAgent` wrapper extending `@ag-ui/client`. Designed as a thin client for connecting to OpenResponses endpoints.

Key file: `typescript/src/index.ts`

### Python Examples (`python/examples/`)

Reference server demonstrating basic AG-UI protocol compliance with FastAPI.

### Event Mapping

| OpenResponses Event | AG-UI Event |
|---------------------|-------------|
| `response.created` | (triggers RUN_STARTED in agent) |
| `response.output_item.added` (message) | `TEXT_MESSAGE_START` |
| `response.output_text.delta` | `TEXT_MESSAGE_CONTENT` |
| `response.output_text.done` | `TEXT_MESSAGE_END` |
| `response.output_item.added` (function_call) | `TOOL_CALL_START` |
| `response.function_call_arguments.delta` | `TOOL_CALL_ARGS` |
| `response.output_item.done` (function_call) | `TOOL_CALL_END` |
| `response.completed` | (triggers RUN_FINISHED in agent) |
| `response.failed` | `RUN_ERROR` |

### Integration with Monorepo

- TypeScript package: `integrations/*/typescript` in `pnpm-workspace.yaml`
- Python package: standalone with `ag-ui-protocol` dependency
- Build orchestration handled by Turborepo (TypeScript only)

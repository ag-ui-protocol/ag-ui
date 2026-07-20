# CLI Agent Orchestrator - AG-UI Python Integration

This directory contains the Python example server for the CLI Agent Orchestrator (CAO) integration with the AG-UI protocol.

## Overview

The example server is a standalone FastAPI application that demonstrates four AG-UI protocol features without requiring a real CAO backend:

| Endpoint | Feature | Description |
|----------|---------|-------------|
| `POST /agentic-chat` | Agentic Chat | Streams a simulated conversation about CLI agent orchestration |
| `POST /shared-state` | Shared State | Streams a STATE_SNAPSHOT with fleet/recipe data |
| `POST /human-in-the-loop` | Human in the Loop | Generates task steps via tool calls for user approval |
| `POST /interrupt` | Interrupt (Flagship) | Full ag-ui interrupt lifecycle with approval/denial flow |

## Getting Started

### Prerequisites

- Python 3.12+
- [uv](https://docs.astral.sh/uv/) package manager

### Installation

```bash
cd examples
uv sync
```

### Running the Server

```bash
uv run dev
```

The server starts on `http://0.0.0.0:8000` by default. Configure with environment variables:

- `HOST` - bind address (default: `0.0.0.0`)
- `PORT` - listen port (default: `8000`)

## Architecture

Each endpoint follows the standard AG-UI server pattern:

1. Accept `RunAgentInput` as the request body
2. Create an `EventEncoder` from the request's Accept header
3. Stream events as Server-Sent Events (SSE) via `StreamingResponse`

### Interrupt Lifecycle

The `/interrupt` endpoint demonstrates the complete interrupt protocol:

1. **Initial request** (no `resume[]`): Returns `RUN_FINISHED` with `outcome.type = "interrupt"` containing an approval request
2. **Resume request** (with `resume[]`): Processes the user's decision (resolved/cancelled) and returns `RUN_FINISHED` with `outcome.type = "success"`

## Development

```bash
# Install with dev dependencies
uv sync

# Run with auto-reload
uv run dev
```

## Related

- [AG-UI Protocol SDK](../../../../sdks/python/) - Core protocol types and encoder
- [Server Starter (All Features)](../../server-starter-all-features/python/examples/) - Reference implementation
- [TypeScript Client](../../../cli-agent-orchestrator/typescript/) - The corresponding TS client package

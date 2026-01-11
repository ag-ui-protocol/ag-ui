# Langroid Integration for AG-UI

This directory contains the complete integration of Langroid with the AG-UI protocol, providing both Python and TypeScript implementations.

## Structure

```
langroid/
├── python/              # Python integration
│   ├── src/
│   │   └── ag_ui_langroid/
│   │       ├── __init__.py
│   │       ├── agent.py        # Core agent adapter
│   │       ├── endpoint.py     # FastAPI endpoint utilities
│   │       ├── types.py        # Type definitions
│   │       └── utils.py        # Utility functions
│   ├── examples/        # Example implementations
│   │   └── server/
│   │       └── api/
│   │           ├── agentic_chat.py
│   │           ├── backend_tool_rendering.py
│   │           ├── shared_state.py
│   │           ├── human_in_the_loop.py
│   │           └── tool_based_generative_ui.py
│   ├── pyproject.toml
│   └── README.md
└── typescript/          # TypeScript client integration
    ├── src/
    │   └── index.ts
    ├── package.json
    ├── tsconfig.json
    ├── tsup.config.ts
    └── README.md
```

## Features

- **Python Integration**: Full AG-UI protocol support for Langroid agents
- **TypeScript Client**: HTTP client for connecting to Langroid Python servers
- **FastAPI Endpoints**: Automatic endpoint creation with CORS and streaming support
- **Example Implementations**: Complete examples for common use cases

## Quick Start

### Python Server

1. Install dependencies:
```bash
cd python
pip install -e .
cd examples
pip install -e .
```

2. Create a `.env` file:
```
GEMINI_API_KEY=your-gemini-api-key-here
```

3. Run an example:
```bash
uvicorn server.api.agentic_chat:app --reload --port 8000
```

### TypeScript Client

```typescript
import { LangroidHttpAgent } from "@ag-ui/langroid";

const agent = new LangroidHttpAgent({
  url: "http://localhost:8000/",
});
```

## Architecture

The integration follows the same pattern as other AG-UI integrations:

1. **Agent Adapter** (`agent.py`): Wraps Langroid agents and converts their events to AG-UI protocol events
2. **Endpoint** (`endpoint.py`): Creates FastAPI endpoints with proper event encoding
3. **TypeScript Client**: Provides HTTP agent for frontend applications

## Examples

- **agentic_chat**: Basic conversational agent
- **backend_tool_rendering**: Backend-executed tools
- **shared_state**: Collaborative state management
- **human_in_the_loop**: Human approval workflows
- **tool_based_generative_ui**: Generative UI with tools

## Documentation

See individual README files:
- [Python README](python/README.md)
- [TypeScript README](typescript/README.md)
- [Examples README](python/examples/README.md)


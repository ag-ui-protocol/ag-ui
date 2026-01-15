# Langroid Integration for AG-UI

Complete integration of Langroid with the AG-UI protocol, providing Python and TypeScript implementations.

## Quick Start

### Installation

1. Install dependencies:
```bash
cd python
pip install -e .
cd examples
pip install -e .
```

2. Create a `.env` file in `python/examples/`:
```
OPENAI_API_KEY=your-openai-api-key-here
```

### Running the Server

Run the server from the `python/examples/` directory:

```bash
cd python/examples
poetry run python -m server
```

The server will start on **http://0.0.0.0:8003**

### Examples

The server includes several examples:
- **agentic_chat**: Basic conversational agent with frontend tools
- **backend_tool_rendering**: Backend-executed tools (weather, charts)
- **shared_state**: Collaborative recipe editor with state synchronization
- **agentic_generative_ui**: Multi-step workflows with state management

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for detailed implementation documentation.

## Documentation

- [Python README](python/README.md)
- [TypeScript README](typescript/README.md)
- [Examples README](python/examples/README.md)


# Pydantic AI AG-UI Examples

This directory contains example usage of the AG-UI adapter for Pydantic AI. It provides a FastAPI application that demonstrates how to use the Pydantic AI agent with the AG-UI protocol.

## Features

The examples include implementations for each of the AG-UI dojo features:
- Agentic Chat
- Human in the Loop
- Agentic Generative UI
- Tool Based Generative UI
- Shared State
- Predictive State Updates

## Setup

### Using uv (Recommended)

1. Install dependencies:
   ```bash
   uv sync
   ```

2. Run the development server:
   ```bash
   uv run dev
   ```

### Using pip

1. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```

2. Run the development server:
   ```bash
   python -m pydantic_ai_examples
   ```

## Usage

Once the server is running, you can access the different examples at:

- `http://localhost:9000/agentic_chat` - Agentic Chat
- `http://localhost:9000/agentic_generative_ui` - Agentic Generative UI
- `http://localhost:9000/human_in_the_loop` - Human in the Loop
- `http://localhost:9000/predictive_state_updates` - Predictive State Updates
- `http://localhost:9000/shared_state` - Shared State
- `http://localhost:9000/tool_based_generative_ui` - Tool Based Generative UI

## Development

To install development dependencies:

```bash
uv sync --extra dev
```

This will install additional tools for testing, formatting, and type checking.
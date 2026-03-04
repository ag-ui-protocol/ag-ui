# Agno Finance Agent

An Agno Agent with Finance tools for AG-UI that researches stock prices, analyst recommendations, and stock fundamentals.

## Setup

This project uses [uv](https://github.com/astral-sh/uv) for dependency management.

### Prerequisites

1. Install uv: `pip install uv`
2. Set your OpenAI API key: `export OPENAI_API_KEY="your-api-key"`

### Installation

```bash
# Install dependencies
uv sync

# Activate the virtual environment
uv shell
```

### Running the Agent

```bash
# Run the agent
uv run python agent.py
```

The agent will be available at `http://localhost:9001` (or the port specified by the `PORT` environment variable).

## Development

```bash
# Install development dependencies
uv sync --extra dev

# Run tests
uv run pytest

# Format code
uv run black .
uv run isort .

# Lint code
uv run flake8 .
```

## Features

- Stock price lookup
- Analyst recommendations
- Stock fundamentals analysis
- AG-UI compatible interface
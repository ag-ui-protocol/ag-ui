# ADK Middleware Examples

This directory contains example implementations of the ADK middleware with FastAPI.

## Setup

1. Install dependencies:
   ```bash
   uv sync
   ```

2. Run the development server:
   ```bash
   uv run dev
   ```

## Available Endpoints

- `/` - Root endpoint with basic information
- `/chat` - Basic chat agent
- `/adk-tool-based-generative-ui` - Tool-based generative UI example
- `/adk-human-in-loop-agent` - Human-in-the-loop example
- `/adk-shared-state-agent` - Shared state example
- `/adk-predictive-state-agent` - Predictive state updates example
- `/docs` - FastAPI documentation

## Features Demonstrated

- **Basic Chat**: Simple conversational agent
- **Tool Based Generative UI**: Agent that generates haiku with image selection
- **Human in the Loop**: Task planning with human oversight
- **Shared State**: Recipe management with persistent state
- **Predictive State Updates**: Document writing with state awareness

## Requirements

- Python 3.9+
- Google ADK (google.adk)
- ADK Middleware package

# ag-ui-langroid

Implementation of the AG-UI protocol for Langroid.

Provides a complete Python integration for Langroid agents with the AG-UI protocol, including FastAPI endpoint creation and comprehensive event streaming.

## Installation

```bash
pip install ag-ui-langroid
```

## Usage

```python
from langroid import Agent
from langroid.language_models import OpenAIChatModel
from ag_ui_langroid import LangroidAgent, create_langroid_app

# Create a Langroid agent
model = OpenAIChatModel()
agent = Agent(
    name="assistant",
    system_message="You are a helpful assistant.",
    llm=model,
)

# Wrap with AG-UI adapter
agui_agent = LangroidAgent(
    agent=agent,
    name="agentic_chat",
    description="Conversational Langroid agent with AG-UI streaming",
)

# Create FastAPI app
app = create_langroid_app(agui_agent, "/")
```

## Features

- **Native Langroid integration** – Direct support for Langroid agents and tools
- **FastAPI endpoint creation** – Automatic HTTP endpoint generation with proper event streaming
- **Advanced event handling** – Comprehensive support for all AG-UI events including tool calls and state updates
- **Message translation** – Seamless conversion between AG-UI and Langroid message formats

## Examples

See the `examples/` directory for complete working examples demonstrating:
- Agentic chat
- Tool-based generative UI
- Backend tool rendering
- Shared state management
- Human-in-the-loop interactions


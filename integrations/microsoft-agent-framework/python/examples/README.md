# Microsoft Agent Framework AG-UI Integration

This directory contains examples for using the Microsoft Agent Framework with the AG-UI protocol in the Dojo application.

## Prerequisites

- Python 3.10 or higher
- [uv](https://docs.astral.sh/uv/) for dependency management
- An OpenAI API key or Azure OpenAI endpoint

## Installation

1. Install dependencies:

```bash
cd integrations/microsoft-agent-framework/python/examples
uv sync
```

2. Create a `.env` file based on `.env.example`:

```bash
cp .env.example .env
```

3. Add your API credentials to `.env`:

```bash
# For OpenAI
OPENAI_API_KEY=your_api_key_here
OPENAI_CHAT_MODEL_ID=your_model_here

# Or for Azure OpenAI
AZURE_OPENAI_ENDPOINT=your_endpoint_here
# If using token auth, this env var is not necessary
# AZURE_OPENAI_API_KEY=your_api_key_here
AZURE_OPENAI_CHAT_DEPLOYMENT_NAME=your_deployment_here
```

## Authentication

The sample uses `AzureCliCredential` for authentication. Run `az login` in your terminal before running the examples, or replace `AzureCliCredential` with your preferred authentication method.

## Required role-based access control (RBAC) roles

To access the Azure OpenAI API, your Azure account or service principal needs one of the following RBAC roles assigned to the Azure OpenAI resource:

- **Cognitive Services OpenAI User**: Provides read access to Azure OpenAI resources and the ability to call the inference APIs. This is the minimum role required for running these examples.
- **Cognitive Services OpenAI Contributor**: Provides full access to Azure OpenAI resources, including the ability to create, update, and delete deployments and models.

For most scenarios, the **Cognitive Services OpenAI User** role is sufficient. You can assign this role through the Azure portal under the Azure OpenAI resource's "Access control (IAM)" section.

For more detailed information about Azure OpenAI RBAC roles, see: [Role-based access control for Azure OpenAI Service](https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/role-based-access-control)

## Running the Examples

### 1. Start the Backend Server

In the examples directory, start the Dojo backend server:

```bash
cd integrations/microsoft-agent-framework/python/examples
uv run dev
```

The server will start on `http://localhost:8888` by default.

### 2. Start the Dojo Frontend

In a separate terminal, start the Dojo web application:

```bash
cd apps/dojo
pnpm dev
```

The Dojo frontend will be available at `http://localhost:3000`.

### 3. Connect to Your Agent

1. Open `http://localhost:3000` in your browser
2. Configure the server URL to `http://localhost:8888`
3. Select one "Microsoft Agent Framework (Python)" from the dropdown
4. Start exploring the samples

## Available Endpoints

The server exposes the following example agents demonstrating all 7 AG-UI features:

- `/agentic_chat` - Basic conversational agent with tool calling (Feature 1: Agentic Chat)
- `/backend_tool_rendering` - Agent demonstrating backend tool rendering (Feature 2: Backend Tool Rendering)
- `/human_in_the_loop` - Agent with human-in-the-loop workflows (Feature 3: Human in the Loop)
- `/agentic_generative_ui` - Agent that breaks down tasks into steps with streaming updates (Feature 4: Agentic Generative UI)
- `/tool_based_generative_ui` - Agent that generates custom UI components (Feature 5: Tool-based Generative UI)
- `/shared_state` - Agent with bidirectional state synchronization (Feature 6: Shared State)
- `/predictive_state_updates` - Agent with predictive state updates during tool execution (Feature 7: Predictive State Updates)

## Project Structure

```
examples/
├── agents/
│   ├── agentic_chat/                  # Feature 1: Basic chat agent
│   ├── backend_tool_rendering/        # Feature 2: Backend tool rendering
│   ├── human_in_the_loop/             # Feature 3: Human-in-the-loop
│   ├── agentic_generative_ui/         # Feature 4: Streaming state updates
│   ├── tool_based_generative_ui/      # Feature 5: Custom UI components
│   ├── shared_state/                  # Feature 6: Bidirectional state sync
│   ├── predictive_state_updates/      # Feature 7: Predictive state updates
│   └── dojo.py                        # FastAPI application setup
├── pyproject.toml                     # Dependencies and scripts
├── .env.example                       # Environment variable template
└── README.md                          # This file
```

## Using Different Chat Clients

The Microsoft Agent Framework supports multiple chat clients. You can mix and match different clients for different agents:

### Azure OpenAI (Default)

```python
from agent_framework.azure import AzureOpenAIChatClient

azure_client = AzureOpenAIChatClient()
agent = simple_agent(azure_client)
```

### OpenAI

```python
from agent_framework.openai import OpenAIChatClient

openai_client = OpenAIChatClient(model_id="gpt-4o")
agent = weather_agent(openai_client)
```

### Mixing Clients

You can use different chat clients for different agents in the same application:

```python
from agent_framework.azure import AzureOpenAIChatClient
from agent_framework.openai import OpenAIChatClient

# Create clients
azure_client = AzureOpenAIChatClient()
openai_client = OpenAIChatClient(model_id="gpt-4o")

# Use different clients for different agents
agent1 = simple_agent(azure_client)
agent2 = weather_agent(openai_client)
agent3 = recipe_agent(azure_client)
```

See `agents/dojo.py` for a complete example.

## Development

To add a new example agent:

1. Create a new directory under `agents/`
2. Add an `agent.py` file with your agent implementation
3. Import and register it in `agents/dojo.py`

## Dependencies

This integration uses:

- `agent-framework-ag-ui` - Microsoft Agent Framework AG-UI adapter
- `fastapi` - Web framework for the server
- `uvicorn` - ASGI server
- `python-dotenv` - Environment variable management

## License

MIT

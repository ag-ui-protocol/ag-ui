# AG-UI OpenResponses Integration

AG-UI agent for OpenResponses-compatible endpoints.

## Supported Providers

| Provider | Base URL | Notes |
|----------|----------|-------|
| OpenAI | `https://api.openai.com/v1` | Native implementation |
| Azure OpenAI | `https://{resource}.openai.azure.com` | Requires `api-version` param |
| Hugging Face | `https://api-inference.huggingface.co/v1` | Open Responses initiative |
| OpenClaw | `http://localhost:18789` | Multi-agent gateway with agent routing |

## Installation

```bash
pip install ag-ui-openresponses
```

## Quick Start

```python
import asyncio
from ag_ui_openresponses import OpenResponsesAgent, OpenResponsesAgentConfig

async def main():
    agent = OpenResponsesAgent(
        OpenResponsesAgentConfig(
            base_url="https://api.openai.com/v1",
            api_key="your-api-key",
            default_model="gpt-4o",
        )
    )

    async for event in agent.run({
        "thread_id": "thread-1",
        "run_id": "run-1",
        "messages": [
            {"role": "user", "content": "Hello!"}
        ],
    }):
        print(f"Event: {event}")

asyncio.run(main())
```

## FastAPI Integration

```python
from fastapi import FastAPI
from ag_ui_openresponses import create_openresponses_endpoint, OpenResponsesAgent, OpenResponsesAgentConfig

app = FastAPI()

agent = OpenResponsesAgent(
    OpenResponsesAgentConfig(
        base_url="https://api.openai.com/v1",
        api_key="your-api-key",
    )
)

create_openresponses_endpoint(app, agent, path="/agent")
```

## OpenClaw with Agent Routing

```python
from ag_ui_openresponses import (
    OpenResponsesAgent,
    OpenResponsesAgentConfig,
    OpenClawProviderConfig,
)

agent = OpenResponsesAgent(
    OpenResponsesAgentConfig(
        base_url="http://localhost:18789",
        api_key="your-token",
        default_model="openclaw:main",
        openclaw=OpenClawProviderConfig(
            agent_id="main",
            session_key="user-123",
        ),
    )
)
```

# ag-ui-crewai

Implementation of the AG-UI protocol for CrewAI.

Provides a complete Python integration for CrewAI flows and crews with the AG-UI protocol, including FastAPI endpoint creation and comprehensive event streaming.

## Installation

```bash
pip install ag-ui-crewai
```

## Usage

```python
from crewai.flow.flow import Flow, start
from litellm import completion
from ag_ui_crewai import (
    add_crewai_flow_fastapi_endpoint,
    copilotkit_stream,
    CopilotKitState
)
from fastapi import FastAPI

class MyFlow(Flow[CopilotKitState]):
    @start()
    async def chat(self):
        response = await copilotkit_stream(
            completion(
                model="openai/gpt-4o",
                messages=[
                    {"role": "system", "content": "You are a helpful assistant."},
                    *self.state.messages
                ],
                tools=self.state.copilotkit.actions,
                stream=True
            )
        )
        self.state.messages.append(response.choices[0].message)

# Add to FastAPI
app = FastAPI()
add_crewai_flow_fastapi_endpoint(app, MyFlow(), "/flow")
```

## Features

- **Native CrewAI integration** – Direct support for CrewAI flows, crews, and multi-agent systems
- **FastAPI endpoint creation** – Automatic HTTP endpoint generation with proper event streaming
- **Predictive state updates** – Real-time state synchronization between backend and frontend
- **Streaming tool calls** – Live streaming of LLM responses and tool execution to the UI

## To run the dojo examples

```bash
cd python/ag_ui_crewai
poetry install
poetry run dev
```

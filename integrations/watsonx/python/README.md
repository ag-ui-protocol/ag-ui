# ag_ui_watsonx

Python AG-UI adapter for IBM watsonx orchestrate agents.

## Installation

```bash
pip install ag_ui_watsonx
```

## Quick Start

```python
from ag_ui_watsonx import WatsonxAgent, create_watsonx_app

agent = WatsonxAgent(
    region="au-syd",
    instance_id="your-instance-id",
    agent_id="your-watsonx-agent-id",
    api_key="YOUR_API_KEY",
)

app = create_watsonx_app(agent)
```

Run with:

```bash
uvicorn main:app --port 8000
```

# ag-ui-flowise

Flowise integration for AG-UI protocol.

## Installation

```bash
pip install ag-ui-flowise
```

## Usage

```python
from ag_ui_flowise import FlowiseAgent, FlowiseAgentConfig

config = FlowiseAgentConfig(
    api_url="http://localhost:3000/api/v1/prediction/{flowId}",
    flow_id="your-flow-id",
    api_key="your-api-key"  # Optional
)

agent = FlowiseAgent(config)

# Use the agent with AG-UI components
```

## API Reference

### FlowiseAgentConfig

| Property | Type | Description |
|---------|------|-------------|
| `api_url` | str | The Flowise API endpoint URL |
| `flow_id` | str | The Flowise flow ID |
| `api_key` | str (optional) | API key for authentication |
| `headers` | Dict[str, str] (optional) | Additional headers to send with requests |

## License

MIT
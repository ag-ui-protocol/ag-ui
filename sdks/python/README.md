# ag-ui-protocol

Python SDK for the **Agent-User Interaction (AG-UI) Protocol**.

`ag-ui-protocol` provides Python developers with strongly-typed data structures and event encoding for building AG-UI compatible agent servers. Built on Pydantic for robust validation and automatic camelCase serialization for seamless frontend integration.

## Installation

```bash
pip install ag-ui-protocol
poetry add ag-ui-protocol
pipenv install ag-ui-protocol
```

## Features

- 🐍 **Python-native** – Idiomatic Python APIs with full type hints and validation
- 📋 **Pydantic models** – Runtime validation and automatic JSON serialization
- 🔄 **Streaming events** – 16 core event types for real-time agent communication
- ⚡ **High performance** – Efficient event encoding for Server-Sent Events

## Quick example

```python
from ag_ui.core import TextMessageContentEvent, EventType
from ag_ui.encoder import EventEncoder

# Create a streaming text event
event = TextMessageContentEvent(
    type=EventType.TEXT_MESSAGE_CONTENT,
    message_id="msg_123",
    delta="Hello from Python!"
)

# Encode for HTTP streaming
encoder = EventEncoder()
sse_data = encoder.encode(event)
# Output: data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"msg_123","delta":"Hello from Python!"}\n\n
```

## Packages

- **`ag_ui.core`** – Types, events, and data models for AG-UI protocol
- **`ag_ui.encoder`** – Event encoding utilities for HTTP streaming

## Documentation

- Concepts & architecture: [`docs/concepts`](https://docs.ag-ui.com/concepts/architecture)
- Full API reference: [`docs/sdk/python`](https://docs.ag-ui.com/sdk/python/core/overview)

## Contributing

Bug reports and pull requests are welcome! Please read our [contributing guide](https://docs.ag-ui.com/development/contributing) first.

## License

MIT © 2025 AG-UI Protocol Contributors

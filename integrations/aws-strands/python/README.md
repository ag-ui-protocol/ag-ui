# AWS Strands Integration for AG-UI

This package exposes a lightweight wrapper that lets any `strands.Agent` speak the AG-UI protocol. It mirrors the developer experience of the other integrations: give us a Strands agent instance, plug it into `StrandsAgent`, and wire it to FastAPI via `create_strands_app` (or `add_strands_fastapi_endpoint`).

## Prerequisites

- Python 3.10+
- `poetry` (recommended) or `pip`
- A Strands-compatible model key (e.g., `GOOGLE_API_KEY` for Gemini)

## Quick Start


The `examples/server/__main__.py` module mounts all demo routes behind a single FastAPI app. Run:

```bash
cd integrations/aws-strands/python/examples
poetry install
poetry run python -m server
```

It exposes:

| Route | Description |
| --- | --- |
| `/agentic-chat` | Frontend tool demo |
| `/backend-tool-rendering` | Backend tool rendering demo |
| `/shared-state` | Shared recipe state |
| `/agentic-generative-ui` | Agentic UI with PredictState |

This is the easiest way to test multiple flows locally. Each route still follows the pattern described below (Strands agent → wrapper → FastAPI).

## Architecture Overview

The integration has three main layers:

- **StrandsAgent** – wraps `strands.Agent.stream_async`. It translates Strands events into AG-UI events (text chunks, tool calls, PredictState, snapshots, etc.).
- **Configuration** – `StrandsAgentConfig` + `ToolBehavior` + `PredictStateMapping` let you describe tool-specific quirks declaratively (skip message snapshots, emit state, stream args, send confirm actions, etc.).
- **Transport helpers** – `create_strands_app` and `add_strands_fastapi_endpoint` expose the agent via SSE. They are thin shells over the shared `ag_ui.encoder.EventEncoder`.

See [ARCHITECTURE.md](ARCHITECTURE.md) for diagrams and a deeper dive.


## Key Files

| File | Description |
| --- | --- |
| `src/ag_ui_strands/agent.py` | Core wrapper translating Strands streams into AG-UI events |
| `src/ag_ui_strands/config.py` | Config primitives (`StrandsAgentConfig`, `ToolBehavior`, `PredictStateMapping`) |
| `src/ag_ui_strands/endpoint.py` | FastAPI endpoint helper |
| `examples/server/api/*.py` | Ready-to-run demo apps |

## Amazon Bedrock AgentCore considerations

If you are planning to deploy your agent into Amazon Bedrock AgentCore (AC), please note that AC expects the following:
- The server is running on port 8080.
- The path `/invocations - POST` is implemented and can be used for interacting with the agent.
- The path `/ping - GET` is implemented and can be used for verifying that the agent is operational and ready to handle requests.

To implement the path mentioned above, you can use the helper function `create_strands_app` and pass the agent interaction path and the ping path as shown below:
```python
    create_strands_app(agui_agent, "/invocations", "/ping")
```
You can also use the helper functions `add_strands_fastapi_endpoint` and `add_ping` for adding the mentioned paths to a FastAPI app that you are creating separately:

```python
    add_strands_fastapi_endpoint(app, agent, "/invocations")
    add_ping(app, "/ping")
```

Requests to AC endpoint needs to be authenticated and authorized. You can configure your agent runtime to accept JWT bearer tokens, and configure the server-side component of the UI to send access token as an HTTP header to AC.


## Next Steps

- Wire Strands’ callback handler into the wrapper to expose multi-agent metadata.
- Add an event queue layer (like the ADK middleware) for resumable streams and non-HTTP transports.
- Expand the test suite as new behaviors land.


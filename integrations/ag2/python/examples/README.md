# AG2 AG-UI Example

AG2 (formerly AutoGen) agent exposed via the [AG-UI](https://docs.ag2.ai/latest/docs/user-guide/ag-ui/) protocol for the Dojo.

## Prerequisites

- Python 3.10+
- [uv](https://github.com/astral-sh/uv): `pip install uv` or `brew install uv`
- `OPENAI_API_KEY` set in the environment

## Setup

```bash
uv sync
```

## Run

```bash
uv run dev
```

The server listens on `http://localhost:8018` (or the port set by the `PORT` environment variable).

## Endpoints

- `POST /agentic_chat` – Agentic chat agent (AG-UI compatible stream)
- `POST /backend_tool_rendering` – Backend tool rendering (weather assistant with get_weather tool)

## References

- [AG2 AG-UI documentation](https://docs.ag2.ai/latest/docs/user-guide/ag-ui/)
- [AG-UI Protocol](https://docs.ag-ui.com/introduction)

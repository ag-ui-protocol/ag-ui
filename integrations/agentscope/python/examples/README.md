# AgentScope AG-UI examples

These examples connect AgentScope 2's native AG-UI protocol middleware to the Dojo's `RunAgentInput` requests. They demonstrate streaming chat and backend tool rendering. No second AgentScope-to-AG-UI event mapper is maintained here.

```sh
uv sync --locked
export OPENAI_API_KEY="your-key"
uv run dev
```

The server binds to `HOST` (default `0.0.0.0`) and `PORT` (default `8031`). `OPENAI_MODEL` selects the model, defaulting to `gpt-4.1-mini`; `OPENAI_BASE_URL` optionally selects an OpenAI-compatible endpoint. `GET /health` requires no model call. POST AG-UI requests to `/agentic_chat/` or `/backend_tool_rendering/`.

For deterministic local qualification without credentials or provider calls, set `AG_UI_AGENTSCOPE_OFFLINE=1`. This still runs an actual AgentScope `Agent`, its model streaming machinery, and its `FunctionTool` loop. The weather tool always returns illustrative data rather than a live forecast.

The request adapter replays the supplied history and text context into a fresh managed Agent per run. The native protocol middleware is also instantiated per request so its model name and tool-result buffers cannot leak between concurrent streams. Runtime correlation uses the caller's `threadId` and `runId`; the framework continues to own message and tool-call identities.

This first integration exposes only chat and backend tools. It does not inject frontend tools, implement approval/client-tool continuations, shared state, multimodal input, or durable server-side sessions. Unsupported interactive pauses produce a run error.

```sh
uv run --locked pytest
uv run --locked ruff check .
uv run --locked ruff format --check .
```

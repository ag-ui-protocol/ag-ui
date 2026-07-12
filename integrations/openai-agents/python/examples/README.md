# OpenAI Agents SDK examples

Runnable demos for `ag_ui_openai_agents`, one FastAPI route per agent. Two
servers, same demos and same output, showing the two ways to build:

- **`translator_server.py`** — the translator by hand (`to_sdk` →
  `Runner.run_streamed` → `to_agui`). **Recommended.** Full control of the
  agent and the server; `AGUITranslator` is just an events translator. Every
  step is visible; branch mid-run if you need to.
- **`server.py`** — the serve layer (`OpenAIAgentsAgent` +
  `add_openai_agents_fastapi_endpoint`). One wrapped agent + one endpoint call
  per demo, no run loop to get wrong — an opinionated shortcut that trades
  control for less code.

Model provider is **native OpenAI**
(`OPENAI_API_KEY`) — the translators are provider-agnostic, but these
examples exercise the plain-OpenAI path deliberately, since that's what most
integrators will run in production. (LiteLLM/Gemini and the
`FAKE_RESPONSES_ID` handling are covered by the drift-guard/unit tests, not
these examples.)

## Running the server

```bash
cd examples
uv sync
cp .env.example .env   # fill in OPENAI_API_KEY
uv run python server.py
```

Server runs on **http://localhost:8022** (the port the AG-UI Dojo expects;
override with `PORT`).

## Testing

```bash
curl -N -X POST http://localhost:8022/agentic_chat \
  -H 'Content-Type: application/json' \
  -d '{
    "thread_id": "t1",
    "run_id":    "r1",
    "messages":  [{"id":"m1","role":"user","content":"Say hi in one sentence."}],
    "tools":     [],
    "state":     {},
    "context":   [],
    "forwarded_props": null
  }'
```

Swap the path to hit a different demo — `GET /health` lists every registered
agent. Demos map 1:1 onto the AG-UI Dojo feature pages, plus a multi-agent
pattern (`orchestrator`).

> The stateful demos (`shared_state`, `agentic_generative_ui`,
> `predictive_state_updates`) are shelved together with the `AGUIContext`
> state bridge — see `.dev/shelved/` in the package root.

## Agents

### `agentic_chat`
Plain conversation, no tools. Exercises `TEXT_MESSAGE_START/CONTENT/END`
only — the smallest possible smoke test.

**Try:** `"Say hi in one sentence."`

### `backend_tool_rendering`
A server-side `@function_tool` (`get_weather`) the SDK executes itself.
Exercises `TOOL_CALL_START/ARGS/END` + `TOOL_CALL_RESULT`.

**Try:** `"What's the weather in Berlin?"`

### `human_in_the_loop`
A *frontend*-owned tool (`generate_task_steps`) declared by the client in
`RunAgentInput.tools`, not the server. Uses the SDK's built-in
`tool_use_behavior=StopAtTools(...)` so the run ends the moment the model
calls it — the tool body never executes server-side. The frontend renders
the steps, gets user approval, and sends the result back as an ordinary
`ToolMessage` in the next request; no custom pause/resume state needed.

**Try:** `"Plan a birthday party."` — requires a client that actually sends
a `generate_task_steps` tool definition in `RunAgentInput.tools` (e.g. the
AG-UI Dojo's human-in-the-loop page, which uses the same tool name).

### `tool_based_generative_ui`
Another frontend-owned tool (`generate_haiku`), but here the tool call *is*
the deliverable: the frontend renders the haiku card straight from the
streamed `TOOL_CALL_ARGS` — no approval round-trip. Same `StopAtTools`
mechanics as `human_in_the_loop`.

**Try:** `"Write me a haiku about the ocean."` — needs a client that sends a
`generate_haiku` tool definition (Dojo's tool-based generative UI page).

### `orchestrator`
Multi-agent via the SDK's **agents-as-tools** pattern (`Agent.as_tool()`) —
control never transfers, the orchestrator calls `research_agent`,
`writer_agent`, and `critic_agent` as tools and synthesizes the final answer
itself. Each specialist invocation appears to the client as a normal
`TOOL_CALL_*` + `TOOL_CALL_RESULT` sequence; the nested agents' inner turns
stay internal to the SDK.

**Try:** `"Write a short piece about the history of coffee."`

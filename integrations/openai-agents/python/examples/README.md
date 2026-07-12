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

> **vs. `human_in_the_loop_approval` (below):** here the tool has *no server
> implementation* — only the browser can run it, so there's nothing to gate.
> `human_in_the_loop_approval` is the opposite case: a real backend tool,
> paused by the SDK's own approval API before *its* body runs. Different
> problem, different mechanism — see the comparison table under
> `human_in_the_loop_approval`.

### `tool_based_generative_ui`
Another frontend-owned tool (`generate_haiku`), but here the tool call *is*
the deliverable: the frontend renders the haiku card straight from the
streamed `TOOL_CALL_ARGS` — no approval round-trip. Same `StopAtTools`
mechanics as `human_in_the_loop`.

**Try:** `"Write me a haiku about the ocean."` — needs a client that sends a
`generate_haiku` tool definition (Dojo's tool-based generative UI page).

### `human_in_the_loop_approval`
A *backend*-owned tool (`issue_refund`) that requires approval before it
runs — the SDK's `needs_approval=True` (`agents.tool.function_tool`), not an
AG-UI concept. Unlike `human_in_the_loop`, the tool has a real server-side
implementation; the SDK itself pauses the run and reports a
`ToolApprovalItem` on `result.interruptions` before the body ever executes.
That's only known once the stream is fully drained, so this demo is
hand-routed (see `server.py` / `translator_server.py`) instead of running
through the shared loop:

1. First request runs normally; if `result.interruptions` is non-empty after
   the stream ends, the server serializes the paused run
   (`result.to_state()`), keeps it in memory keyed by `thread_id`, and sends
   a `CustomEvent(name="approval_request")` as `to_agui()`'s
   `end_custom_event` — right before `RUN_FINISHED`, not after (the client
   drops anything that arrives once a run is marked finished).
2. The client's decision comes back on the *next* request as
   `RunAgentInput.forwarded_props["approval"]` (`{"call_id", "approve"}`).
   The server looks up the stored state, calls `state.approve()` /
   `state.reject()`, and resumes with `Runner.run_streamed(agent, state)`
   instead of starting over from `translated.messages`.

**Try:** `"I'd like a refund for ORD-1001."` — requires a client that renders
`approval_request` custom events and sends the decision back via
`forwarded_props` (the AG-UI Dojo's Human in the Loop (Backend Approval)
page does this).

**`human_in_the_loop_approval` vs. `human_in_the_loop` — same goal, different mechanism:**

| | `human_in_the_loop` | `human_in_the_loop_approval` |
|---|---|---|
| Who owns the tool | Frontend — no server implementation exists | Backend — real `@function_tool` code |
| What pauses the run | `StopAtTools`, the instant the model calls it | The SDK's own `needs_approval` gate, before the body runs |
| How the pause surfaces | Normal `TOOL_CALL_*` events, mid-stream | `result.interruptions`, only known after the stream ends |
| How the decision comes back | An ordinary `ToolMessage` in the next request's `messages` | `RunAgentInput.forwarded_props["approval"]`, resumed via a stored `RunState` |
| Why | The action can *only* happen client-side (render UI, wait on a click) | The backend *can* do it, but shouldn't without sign-off first |

### `orchestrator`
Multi-agent via the SDK's **agents-as-tools** pattern (`Agent.as_tool()`) —
control never transfers, the orchestrator calls `research_agent`,
`writer_agent`, and `critic_agent` as tools and synthesizes the final answer
itself. Each specialist invocation appears to the client as a normal
`TOOL_CALL_*` + `TOOL_CALL_RESULT` sequence; the nested agents' inner turns
stay internal to the SDK.

**Try:** `"Write a short piece about the history of coffee."`

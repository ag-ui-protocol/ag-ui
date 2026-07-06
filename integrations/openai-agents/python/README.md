# AG-UI × OpenAI Agents SDK

Integrates the [OpenAI Agents SDK](https://openai.github.io/openai-agents-python/)
with the [AG-UI Protocol](https://github.com/ag-ui-protocol/ag-ui). Build your
agent with the OpenAI SDK as usual, then translate its execution into AG-UI
events any AG-UI client (e.g. CopilotKit) can render live.

The integration is a pair of **translators** — it converts data in both
directions and stays out of your way. You own the agent, the run loop, and
the transport; the translators only map shapes:

```
AG-UI RunAgentInput  ──to_sdk()──▶  SDK input items + tools
SDK stream events    ──to_agui()─▶  AG-UI BaseEvents
```

## Install

```bash
pip install ag-ui-openai-agent-sdk
```

For local development this package uses [uv](https://docs.astral.sh/uv/):

```bash
uv sync
```

## Quick start

A complete SSE endpoint — agent, FastAPI, and the streaming translator:

```python
from agents import Agent, Runner
from ag_ui.core import (
    EventType, RunAgentInput,
    RunErrorEvent, RunFinishedEvent, RunStartedEvent,
)
from fastapi import FastAPI
from fastapi.responses import StreamingResponse

from ag_ui_openai_agents import AGUITranslator

agent = Agent(name="assistant", instructions="Be concise.")
translator = AGUITranslator()   # stateless — one instance serves every request
app = FastAPI()


@app.post("/")
async def run(body: RunAgentInput) -> StreamingResponse:
    return StreamingResponse(_stream(body), media_type="text/event-stream")


async def _stream(body: RunAgentInput):
    # 1 — AG-UI input → SDK-ready bundle (messages, tool proxies, passthroughs)
    bundle = translator.to_sdk(body)

    # Client-declared (frontend) tools arrive on the wire — merge per request.
    run_agent = agent
    if bundle.tools:
        run_agent = agent.clone(tools=[*agent.tools, *bundle.tools])

    # 2 — lifecycle events are yours, not the translator's
    yield _sse(RunStartedEvent(
        type=EventType.RUN_STARTED, thread_id=body.thread_id, run_id=body.run_id,
    ))

    try:
        # 3 — run the SDK agent; stream translated AG-UI events
        result = Runner.run_streamed(run_agent, input=bundle.messages)
        async for event in translator.to_agui(result.stream_events()):
            yield _sse(event)
    except Exception:
        yield _sse(RunErrorEvent(type=EventType.RUN_ERROR, message="Agent run failed."))
        return

    yield _sse(RunFinishedEvent(
        type=EventType.RUN_FINISHED, thread_id=body.thread_id, run_id=body.run_id,
    ))


def _sse(event) -> bytes:
    return f"data: {event.model_dump_json(by_alias=True, exclude_none=True)}\n\n".encode()
```

Test it:

```bash
curl -N -X POST http://localhost:8000 \
  -H 'Content-Type: application/json' \
  -d '{
    "thread_id": "t1", "run_id": "r1",
    "messages": [{"id":"m1","role":"user","content":"Say hi in one sentence."}],
    "tools": [], "state": {}, "context": [], "forwarded_props": null
  }'
```

Expected: `RUN_STARTED → TEXT_MESSAGE_START → TEXT_MESSAGE_CONTENT (×N) →
TEXT_MESSAGE_END → RUN_FINISHED`.

A full multi-demo server (chat, backend tools, human-in-the-loop, handoffs,
orchestrator) lives in [`examples/`](examples/).

## Public API

Two facade translators, **two methods each** — everything else is theirs to
orchestrate:

| Class | Pairs with | `to_agui(...)` returns |
|---|---|---|
| `AGUITranslator` (main) | `Runner.run_streamed` | async iterator of AG-UI events, live |
| `AGUINonStreamingTranslator` | `Runner.run` / `run_sync` | `list[BaseEvent]`, one shot |

Both are stateless and reusable — each `to_agui` call internally creates the
fresh per-run engine it needs. Create one instance and share it.

### Streaming (the default)

AG-UI is an ordered event stream by design, so streaming is the primary mode:

```python
translator = AGUITranslator()
bundle = translator.to_sdk(run_input)
result = Runner.run_streamed(agent, input=bundle.messages)
async for event in translator.to_agui(result.stream_events()):
    ...  # AG-UI BaseEvent, ready to encode
```

`to_agui` folds all window bookkeeping in: any still-open text / tool-call /
reasoning window is closed automatically when the stream ends.

### Non-streaming

Same valid AG-UI event sequence, produced in one burst after the run
finishes (no token-level deltas):

```python
translator = AGUINonStreamingTranslator()
bundle = translator.to_sdk(run_input)
result = await Runner.run(agent, input=bundle.messages)
events = translator.to_agui(result)   # accepts RunResult or list[RunItem]
```

### What `to_sdk` gives you

`TranslatedInput` mirrors `RunAgentInput` field for field:

| AG-UI field | Lands in |
|---|---|
| `messages` | `bundle.messages` — Responses-API input items for `Runner.run*` |
| `tools` | `bundle.tools` — SDK `FunctionTool` proxies for client-declared tools; merge with `agent.clone(tools=[*agent.tools, *bundle.tools])` |
| `state`, `context`, `forwarded_props` | passthrough — the library never injects them anywhere; render them into instructions/messages yourself if your app needs the model to see them |
| `thread_id`, `run_id`, `parent_run_id`, `resume` | passthrough |

### Division of labor

The translators translate; **your run loop orchestrates**. Lifecycle events
(`RUN_STARTED`/`RUN_FINISHED`/`RUN_ERROR`), `STATE_SNAPSHOT`,
`MESSAGES_SNAPSHOT`, session persistence, and transport (SSE/WebSocket)
stay in your code — see the quick start above for the minimal shape.

## Advanced: the engine layer

The facades delegate to two independent, symmetric engine translators in
`ag_ui_openai_agents.engine`:

- `AGUIToSDKTranslator` — inbound; stateless, tiered per-type methods
  (`translate_user_message`, `translate_tool_message`, ...)
- `SDKToAGUITranslator` — outbound; stateful per run (open text/tool/reasoning
  windows), per-type methods (`translate_text_delta`, `translate_item`, ...)

Every per-type method is a public override point. To customize one mapping,
subclass the engine and inject it — the facade and every other mapping stay
untouched:

```python
from ag_ui_openai_agents import AGUITranslator
from ag_ui_openai_agents.engine import SDKToAGUITranslator


class MyOutbound(SDKToAGUITranslator):
    def translate_text_delta(self, data):
        ...  # your variant of one mapping

translator = AGUITranslator(outbound_cls=MyOutbound)
```

## Frontend (client-owned) tools

Tools declared in `RunAgentInput.tools` belong to the frontend. `to_sdk`
turns them into SDK `FunctionTool` proxies so the model can call them; for
human-in-the-loop flows, end the run the moment such a tool is called by
using the SDK's native mechanism:

```python
from agents import Agent, StopAtTools

agent = Agent(
    ...,
    tool_use_behavior=StopAtTools(stop_at_tool_names=["confirm_changes"]),
)
```

The run stops before the proxy body executes; the frontend answers the tool
call and sends the result back as a `tool` message in the next run's
`messages`. See `examples/agents_examples/human_in_the_loop.py`.

## Supported AG-UI events

- **Text**: `TEXT_MESSAGE_START` / `CONTENT` / `END` (token-level, refusals included)
- **Tool calls**: `TOOL_CALL_START` / `ARGS` / `END` / `RESULT` (args stream as deltas)
- **Reasoning**: `REASONING_START` / `MESSAGE_*` / `END`, plus
  `REASONING_ENCRYPTED_VALUE` for replayable reasoning
- **Hosted tools** (web search, file search, code interpreter, ...): full
  `TOOL_CALL_*` sequences
- **Handoffs & agents-as-tools**: translated as tool calls; `STEP_STARTED` /
  `STEP_FINISHED` for multi-agent steps
- **MCP approval requests**: `CUSTOM` events

Lifecycle (`RUN_*`) and snapshot events are emitted by your run loop, not
the translator (see division of labor above).

## Gotchas

- **Reasoning replay** (sending reasoning back to OpenAI) only works via
  `encrypted_content` — set
  `ModelSettings(response_include=["reasoning.encrypted_content"])` on the
  run. Plaintext reasoning cannot be re-ingested and is dropped inbound.
- The Responses API has no `tool` role — AG-UI `tool` messages become
  `function_call_output` items linked by `call_id`.
- Unknown/unsupported message and event types never crash the translators —
  they are dropped with a debug log.

## Testing

```bash
uv sync            # installs dev group (pytest)
uv run pytest      # run the full suite
```

The suite includes a **drift guard** (`tests/test_stream_types_drift.py`):
this package hardcodes the wire `type` strings it dispatches on (in
`engine/stream_types.py`), and the guard asserts each one against the
`Literal[...]` annotations of the installed `openai-agents` / `openai`
packages. After bumping either dependency, run `uv run pytest` — if a wire
type was renamed or a new hosted tool-call item type was added, the guard
fails with an assertion diff naming the exact value to update in
`stream_types.py`. Unknown types never crash at runtime (the translator
degrades gracefully and skips them); the guard exists so drift is caught in
CI instead of silently dropping events.

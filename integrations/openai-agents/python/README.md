# AG-UI × OpenAI Agents SDK

Integrates the [OpenAI Agents SDK](https://openai.github.io/openai-agents-python/)
with the [AG-UI Protocol](https://github.com/ag-ui-protocol/ag-ui). Build your
agent with the OpenAI SDK as usual, then translate its execution into AG-UI
events any AG-UI client (e.g. CopilotKit) can render live.

The integration is a **translator**. You keep using the OpenAI Agents
SDK normally; the translator only maps data at the AG-UI boundary:

```
AG-UI RunAgentInput    ──to_sdk()──▶  SDK input items + tools
SDK streamed result    ──to_agui()─▶  AG-UI BaseEvents
```

The flow is:

```python
translator = AGUITranslator()

bundle = translator.to_sdk(run_input)
result = Runner.run_streamed(agent, input=bundle.messages)

async for event in translator.to_agui(result):
    ...
```

`to_agui(result)` also accepts `result.stream_events()` if your code already
has the SDK event iterator.

## Install

```bash
pip install ag-ui-openai-agent-sdk
```

For local development this package uses [uv](https://docs.astral.sh/uv/):

```bash
uv sync
```

## Quick Start: Streaming Endpoint

This is the common server shape for AG-UI clients: accept `RunAgentInput`, run
your OpenAI agent with `Runner.run_streamed`, and stream AG-UI events back over
SSE.

```python
from agents import Agent, Runner
from ag_ui.core import (
    EventType, RunAgentInput,
    RunErrorEvent, RunFinishedEvent, RunStartedEvent,
)
from ag_ui.encoder import EventEncoder
from fastapi import FastAPI
from fastapi.responses import StreamingResponse

from ag_ui_openai_agents import AGUITranslator

agent = Agent(name="assistant", instructions="Be concise.")
translator = AGUITranslator()   # stateless — one instance serves every request
encoder = EventEncoder()        # AG-UI's own SSE encoder
app = FastAPI()


@app.post("/")
async def run(body: RunAgentInput) -> StreamingResponse:
    return StreamingResponse(_stream(body), media_type=encoder.get_content_type())


async def _stream(body: RunAgentInput):
    # 1. AG-UI input -> SDK-ready bundle.
    bundle = translator.to_sdk(body)

    # 2. Merge client-declared tools per request.
    run_agent = agent
    if bundle.tools:
        run_agent = agent.clone(tools=[*agent.tools, *bundle.tools])

    # 3. Lifecycle events are emitted by your run loop.
    yield encoder.encode(RunStartedEvent(
        type=EventType.RUN_STARTED, thread_id=body.thread_id, run_id=body.run_id,
    ))

    try:
        # 4. Run the SDK agent normally, then translate the streamed result.
        result = Runner.run_streamed(run_agent, input=bundle.messages)
        async for event in translator.to_agui(result):
            yield encoder.encode(event)
    except Exception:
        yield encoder.encode(
            RunErrorEvent(type=EventType.RUN_ERROR, message="Agent run failed.")
        )
        return

    yield encoder.encode(RunFinishedEvent(
        type=EventType.RUN_FINISHED, thread_id=body.thread_id, run_id=body.run_id,
    ))
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

Expected: `RUN_STARTED -> TEXT_MESSAGE_START -> TEXT_MESSAGE_CONTENT (xN) ->
TEXT_MESSAGE_END -> RUN_FINISHED`.

A full multi-demo server (chat, backend tools, human-in-the-loop, handoffs,
orchestrator) lives in [`examples/`](examples/).

## Public API

There is one public translator; it pairs with the SDK's streaming run mode:

| Class | Pairs with | `to_agui(...)` returns |
|---|---|---|
| `AGUITranslator` | `Runner.run_streamed` | async iterator of AG-UI events, live |

It is stateless and reusable — each `to_agui` call internally creates the
fresh per-run engine it needs. Create one instance and share it.

### Choose a Pattern

| Need | Use |
|---|---|
| Live chat, tool-call progress, reasoning progress | `AGUITranslator` with `Runner.run_streamed` |
| FastAPI SSE | Return `StreamingResponse(_stream(...), media_type="text/event-stream")` |
| WebSocket or another async transport | Iterate `translator.to_agui(result)` and send each event JSON |
| Custom model settings, tracing, guardrails, handoffs | Pass normal OpenAI Agents SDK args to `Runner.run_streamed` |
| Custom AG-UI mapping behavior | Subclass an engine translator and inject it into the public translator |

### Streaming: Live AG-UI Output

AG-UI is an ordered event stream by design, so streaming is the primary mode:

```python
translator = AGUITranslator()

bundle = translator.to_sdk(run_input)
result = Runner.run_streamed(agent, input=bundle.messages)

async for event in translator.to_agui(result):
    ...  # AG-UI BaseEvent, ready to encode
```

You may also pass the SDK event iterator directly:

```python
async for event in translator.to_agui(result.stream_events()):
    ...
```

`to_agui` handles the streaming bookkeeping for the run. If the SDK stream ends
while text, tool-call arguments, or reasoning output is still open, the
translator emits the matching close event before the iterator finishes.

All normal OpenAI Agents SDK run options stay on the SDK call:

```python
result = Runner.run_streamed(
    agent,
    input=bundle.messages,
    context=my_context,
    max_turns=8,
    run_config=run_config,
)

async for event in translator.to_agui(result):
    ...
```

### What `to_sdk` gives you

`TranslatedInput` mirrors `RunAgentInput` field for field:

| AG-UI field | Lands in |
|---|---|
| `messages` | `bundle.messages` — Responses-API input items for `Runner.run_streamed` |
| `tools` | `bundle.tools` — SDK `FunctionTool` proxies for client-declared tools; merge with `agent.clone(tools=[*agent.tools, *bundle.tools])` |
| `state`, `context`, `forwarded_props` | passthrough — the library never injects them anywhere; render them into instructions/messages yourself if your app needs the model to see them |
| `thread_id`, `run_id`, `parent_run_id`, `resume` | passthrough |

The most important field is `bundle.messages`; pass it as `input=` to
`Runner.run_streamed`.

If `bundle.tools` is non-empty, merge those tools into the agent for this
request:

```python
run_agent = agent
if bundle.tools:
    run_agent = agent.clone(tools=[*agent.tools, *bundle.tools])
```

### What Your Code Still Owns

The translator translates. Your run loop still owns orchestration:

| Concern | Owned by |
|---|---|
| `RUN_STARTED`, `RUN_FINISHED`, `RUN_ERROR` | Your server |
| `STATE_SNAPSHOT`, `MESSAGES_SNAPSHOT` | Your server, if your app needs them |
| Session storage and thread history | Your server |
| SSE, WebSocket, HTTP response shape | Your server/framework |
| OpenAI agent choice, model settings, handoffs, guardrails | Your OpenAI Agents SDK code |
| AG-UI message/tool/event shape conversion | This package |

This keeps the integration framework-neutral. FastAPI, Starlette, Django,
aiohttp, raw ASGI, WebSockets, or tests can all use the same translator calls.

### Transport Options

For SSE, use the AG-UI SDK's own encoder — it produces one `data:` frame per
event and gives you the matching `Content-Type`:

```python
from ag_ui.encoder import EventEncoder

encoder = EventEncoder()

async for event in translator.to_agui(result):
    yield encoder.encode(event)
```

If you'd rather not depend on the encoder, the equivalent frame by hand is:

```python
def encode_sse(event) -> bytes:
    return f"data: {event.model_dump_json(by_alias=True, exclude_none=True)}\n\n".encode()
```

For WebSockets, send the same JSON payload:

```python
async for event in translator.to_agui(result):
    await websocket.send_text(event.model_dump_json(by_alias=True, exclude_none=True))
```

For tests or in-process consumers, collect events directly:

```python
events = [event async for event in translator.to_agui(result)]
```

### State, Context, and Forwarded Props

`state`, `context`, and `forwarded_props` are preserved on `TranslatedInput`;
the translator does not automatically insert them into model instructions.
That is deliberate, because apps use these fields differently.

One naming collision to be aware of — there are two unrelated "context"s:

- AG-UI `RunAgentInput.context` — readable `{description, value}` items meant
  for the **model** (prompt material).
- OpenAI Agents SDK `context=` on `Runner.run*` — a dependency-injection slot
  for **tools and hooks**; the model never sees it.

AG-UI's `context` field belongs in the prompt (example below); the SDK's
`context=` slot stays yours for whatever your tools need.

```python
bundle = translator.to_sdk(run_input)

instructions = agent.instructions
if bundle.context:
    instructions += "\n\nContext:\n" + "\n".join(
        f"- {item.description}: {item.value}" for item in bundle.context
    )

run_agent = agent.clone(instructions=instructions)
result = Runner.run_streamed(run_agent, input=bundle.messages)
```

## Capabilities

The streaming translator supports the OpenAI Agents SDK stream shapes AG-UI
clients care about:

| Capability | AG-UI output |
|---|---|
| Assistant text | `TEXT_MESSAGE_START`, `TEXT_MESSAGE_CONTENT`, `TEXT_MESSAGE_END` |
| Refusals | Text message events |
| Tool calls | `TOOL_CALL_START`, streamed `TOOL_CALL_ARGS`, `TOOL_CALL_END`, `TOOL_CALL_RESULT` |
| Reasoning text | `REASONING_START`, reasoning message events, `REASONING_END` |
| Encrypted reasoning replay data | `REASONING_ENCRYPTED_VALUE` |
| Hosted tools such as web search, file search, code interpreter | Tool call events |
| Handoffs and agents-as-tools | Tool call events plus step events |
| MCP approval requests | `CUSTOM` events |

Unknown SDK event types are skipped with a debug log instead of crashing the run.

## Advanced: the engine layer

The public translator delegates to two independent, symmetric engine translators in
`ag_ui_openai_agents.engine`:

- `AGUIToSDKTranslator` — inbound; stateless, tiered per-type methods
  (`translate_user_message`, `translate_tool_message`, ...)
- `SDKToAGUITranslator` — outbound; stateful per run (open text/tool/reasoning
  windows), per-type methods (`translate_text_delta`, `translate_item`, ...)

Every per-type method is a public override point. To customize one mapping,
subclass the engine and inject it — the public translator and every other mapping stay
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

## Gotchas

- **Reasoning replay** (sending reasoning back to OpenAI) only works via
  `encrypted_content` — set
  `ModelSettings(response_include=["reasoning.encrypted_content"])` on the
  run. Plaintext reasoning cannot be re-ingested and is dropped inbound.
- The Responses API has no `tool` role — AG-UI `tool` messages become
  `function_call_output` items linked by `call_id`.
- Unknown/unsupported message and event types never crash the translator —
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

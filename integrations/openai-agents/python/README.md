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

async for event in translator.to_agui(result, run_input):
    ...
```

`to_agui(result)` also accepts `result.stream_events()` if your code already
has the SDK event iterator. The stream is always wrapped with `RUN_STARTED`
(first) and `RUN_FINISHED`/`RUN_ERROR` (last) — thread_id/run_id come from
`run_input`, or pass them explicitly. The event just before `RUN_FINISHED`
is a `MESSAGES_SNAPSHOT` by default — see
[Messages Snapshot](#messages-snapshot).

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
from ag_ui.core import RunAgentInput
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

    # 3. Run the SDK agent normally, then translate the streamed result.
    #    to_agui wraps it with RUN_STARTED/RUN_FINISHED/RUN_ERROR and
    #    appends a MESSAGES_SNAPSHOT by default (just before RUN_FINISHED).
    result = Runner.run_streamed(run_agent, input=bundle.messages)
    async for event in translator.to_agui(result, body):
        yield encoder.encode(event)
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
| WebSocket or another async transport | Iterate `translator.to_agui(result, run_input)` and send each event JSON |
| Custom model settings, tracing, guardrails, handoffs | Pass normal OpenAI Agents SDK args to `Runner.run_streamed` |
| Custom AG-UI mapping behavior | Subclass an engine translator and inject it into the public translator |

### Streaming: Live AG-UI Output

AG-UI is an ordered event stream by design, so streaming is the primary mode:

```python
translator = AGUITranslator()

bundle = translator.to_sdk(run_input)
result = Runner.run_streamed(agent, input=bundle.messages)

async for event in translator.to_agui(result, run_input):
    ...  # AG-UI BaseEvent, ready to encode
```

You may also pass the SDK event iterator directly:

```python
async for event in translator.to_agui(result.stream_events(), run_input):
    ...
```

`to_agui` handles the streaming bookkeeping for the run. If the SDK stream ends
while text, tool-call arguments, or reasoning output is still open, the
translator emits the matching close event before the iterator finishes. It
always wraps the whole stream with `RUN_STARTED` (first) and
`RUN_FINISHED`/`RUN_ERROR` (last) — see [Lifecycle Events](#lifecycle-events).

All normal OpenAI Agents SDK run options stay on the SDK call:

```python
result = Runner.run_streamed(
    agent,
    input=bundle.messages,
    context=my_context,
    max_turns=8,
    run_config=run_config,
)

async for event in translator.to_agui(result, run_input):
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

### Lifecycle Events

`to_agui` always wraps the stream: `RUN_STARTED` is the first event
yielded, and `RUN_FINISHED` is the last — or `RUN_ERROR` if the stream
raises, in which case the exception is re-raised after that event so your
own logging/observability still sees it. This covers `asyncio.CancelledError`
too (a mid-stream timeout or dropped connection), not just ordinary
exceptions — it's `BaseException`, not `Exception`, so a plain
`except Exception` would miss it and the client would just see the
stream stop with no `RUN_ERROR` and no `RUN_FINISHED`. Not optional —
every caller needs these three events, so there's no flag to turn them off:

```python
async for event in translator.to_agui(result, run_input):
    yield encoder.encode(event)
```

`thread_id`/`run_id` come straight off `run_input` — no separate params to
pass, since `run_input` is already required for the lifecycle events (and,
by default, the snapshot).

### Messages Snapshot

`MESSAGES_SNAPSHOT` lets the client resync its whole message list in one
event — it reconciles by message id, fixing anything the granular stream
couldn't express (a reload mid-conversation, history rewritten by a handoff
input filter, a dropped connection). `to_agui` appends one by default,
right after the stream's own flush and just before `RUN_FINISHED`, using
`run_input.messages` for the prior turns:

```python
async for event in translator.to_agui(result, run_input):
    yield encoder.encode(event)
```

The snapshot is `run_input.messages` (untouched, keeping the ids the client
already renders) plus this run's messages, built inline as the engine
streams — each message's id is resolved once and handed to both the
streamed event and the snapshot entry, so they can never disagree, even on
backends that don't stamp real ids (LiteLLM and similar). Reasoning items
are not included; the client keeps its streamed reasoning bubbles through
the merge on its own. If the run raises, `to_agui` yields `RUN_ERROR` and
re-raises before the snapshot line runs — nothing is emitted on the error
path.

> `run_input.messages` passes through untouched — filter it first if it
> holds anything the client shouldn't see echoed back, e.g. a system
> prompt sent as history instead of via `agent.instructions`:
> ```python
> filtered = run_input.model_copy(
>     update={"messages": [m for m in run_input.messages if m.role != "system"]}
> )
> async for event in translator.to_agui(result, filtered):
>     ...
> ```

Pass `emit_messages_snapshot=False` to opt out (e.g. you assemble your own).
Auto-emission works the same whether `to_agui` is given the
`RunResultStreaming` object or a bare `result.stream_events()` iterator —
the snapshot is built from the engine's own state (collected as it
streamed), not `result.new_items`, so there's nothing the bare-iterator
form is missing.

### What Your Code Still Owns

The translator translates. Your run loop still owns orchestration:

| Concern | Owned by |
|---|---|
| `RUN_STARTED`, `RUN_FINISHED`, `RUN_ERROR` | `to_agui` (always) |
| `STATE_SNAPSHOT` | Your server, if your app needs it |
| `MESSAGES_SNAPSHOT` | `to_agui` (on by default; pass `emit_messages_snapshot=False` to own it yourself) |
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

async for event in translator.to_agui(result, run_input):
    yield encoder.encode(event)
```

If you'd rather not depend on the encoder, the equivalent frame by hand is:

```python
def encode_sse(event) -> bytes:
    return f"data: {event.model_dump_json(by_alias=True, exclude_none=True)}\n\n".encode()
```

For WebSockets, send the same JSON payload:

```python
async for event in translator.to_agui(result, run_input):
    await websocket.send_text(event.model_dump_json(by_alias=True, exclude_none=True))
```

For tests or in-process consumers, collect events directly:

```python
events = [event async for event in translator.to_agui(result, run_input)]
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

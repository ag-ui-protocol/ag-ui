# AG-UI × OpenAI Agents SDK

Integrates the [OpenAI Agents SDK](https://openai.github.io/openai-agents-python/)
with the [AG-UI Protocol](https://github.com/ag-ui-protocol/ag-ui). Build your
agent with the OpenAI SDK as usual, then translate its execution into AG-UI
events any AG-UI client (e.g. CopilotKit) can render live.

The integration is a **translator**. You keep using the OpenAI Agents SDK
normally; this package maps data only at the AG-UI boundary:

```
AG-UI RunAgentInput    ──to_openai()──▶  SDK input items + tools
SDK streamed result    ──to_agui()─▶  AG-UI BaseEvents
```

The flow is:

```python
translator = AGUITranslator()

translated_input = translator.to_openai(run_input)
result = Runner.run_streamed(agent, input=translated_input.messages)

async for event in translator.to_agui(result, run_input):
  ...
```

`to_agui(result, run_input)` also accepts `result.stream_events()` if your code already
has the SDK event iterator. The stream is always wrapped with `RUN_STARTED`
(first) and `RUN_FINISHED`/`RUN_ERROR` (last); `thread_id` and `run_id` come
from `run_input`. The event just before `RUN_FINISHED`
is a `MESSAGES_SNAPSHOT` by default — see
[Messages Snapshot](#messages-snapshot).

## Install

```bash
pip install ag-ui-openai-agents
```

For local development this package uses [uv](https://docs.astral.sh/uv/):

```bash
uv sync
```

## Quick Start: Compose It Yourself (recommended)

**This is the recommended way to use this integration.** `AGUITranslator` is
just an events translator — it converts at the AG-UI boundary and nothing
else. You keep full control of the agent (any `Agent` config, model,
handoffs, guardrails) and full control of the backend server (FastAPI or
anything else, your own routes, your own SSE/WebSocket framing, your own
session/auth logic). Nothing about your `Runner.run_streamed` call or your
server is owned by this package — accept `RunAgentInput`, run your OpenAI
agent normally, stream AG-UI events back:

```python
from agents import Agent, Runner
from ag_ui.core import RunAgentInput
from ag_ui.encoder import EventEncoder
from fastapi import FastAPI
from fastapi.responses import StreamingResponse

from ag_ui_openai_agents import AGUITranslator

agent = Agent(name="assistant", instructions="Be concise.")
translator = AGUITranslator()  # stateless — one instance serves every request
encoder = EventEncoder()  # AG-UI's own SSE encoder
app = FastAPI()


@app.post("/")
async def run(body: RunAgentInput) -> StreamingResponse:
  """Translate one AG-UI request into an SDK run and stream it back."""

  async def stream():
    # AGUI input -> OpenAI SDK
    translated_input = translator.to_openai(body)

    # merge client-declared tools onto this request's agent
    run_agent = agent
    if translated_input.tools:
      run_agent = agent.clone(tools=[*agent.tools, *translated_input.tools])

    # normal OpenAI SDK streaming run
    result = Runner.run_streamed(run_agent, input=translated_input.messages)

    # OpenAI SDK -> AGUI events
    async for event in translator.to_agui(result, body):
      yield encoder.encode(event)

  return StreamingResponse(stream(), media_type=encoder.get_content_type())
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
TEXT_MESSAGE_END -> MESSAGES_SNAPSHOT -> RUN_FINISHED`. Add state sources to
emit the optional `STATE_SNAPSHOT` events.

`initial_state` and `final_state` opt into the two `STATE_SNAPSHOT` slots.
Pass a static value, zero-argument function, or zero-argument async function;
`None` (the default) skips that snapshot. The initial source is resolved right
after `RUN_STARTED`; the final source is resolved after successful streaming,
just before `MESSAGES_SNAPSHOT`. This lets hooks and tools update
application-owned state:

```python
state = dict(run_input.state or {})
initial_snapshot = dict(state)
translated_input = translator.to_openai(run_input)

result = Runner.run_streamed(agent, input=translated_input.messages, context=state)
async for event in translator.to_agui(
        result,
        run_input,
        initial_state=initial_snapshot,
        final_state=lambda: dict(state),
):
  ...
```

A full multi-demo server (chat, backend tools, human-in-the-loop, handoffs,
orchestrator) lives in [`examples/`](examples/).

## Quick Start: Serve an Agent (opinionated shortcut)

Want the boilerplate above wired up for you instead? Wrap a plain SDK `Agent`
with `OpenAIAgentsAgent`, then hand it to `add_openai_agents_fastapi_endpoint`
— SSE, content negotiation, a `/health` check, lifecycle events, and the
state/messages snapshots are all wired for you. Trades away the control the
translator gives you (agent config is fixed at construction, server is
FastAPI) for less code.

```python
from agents import Agent
from fastapi import FastAPI

from ag_ui_openai_agents import (
    OpenAIAgentsAgent,
    add_openai_agents_fastapi_endpoint,
)

agent = OpenAIAgentsAgent(Agent(name="assistant", instructions="Be concise."))

app = FastAPI()
add_openai_agents_fastapi_endpoint(app, agent, "/")
```

`OpenAIAgentsAgent`:

- holds no per-request state — one instance serves every request; the SDK
  `Agent` is a config template, and client-declared tools are merged onto a
  per-request `clone()`, so concurrent requests never see each other's tools;
- takes `run_config=...` to set run-wide model settings;
- exposes `run(RunAgentInput) -> AsyncIterator[BaseEvent]` if you want to serve
  it on a transport other than FastAPI.

```python
agent = OpenAIAgentsAgent(
    Agent(name="assistant", instructions="Be concise.", model="gpt-5.4-mini"),
)
```

Need finer control (a custom transport, your own SSE framing, per-run
branching)? Use the translator directly — see the section above.

## API overview

Two layers, pick by how much control you want:

| Name | Kind | Use it for |
|---|---|---|
| `AGUITranslator` | translator (recommended) | compose it yourself — `to_openai` + `to_agui`; full control of the agent and server |
| `OpenAIAgentsAgent` | wrapper class | serve an agent: `run(RunAgentInput) -> AsyncIterator[BaseEvent]` |
| `add_openai_agents_fastapi_endpoint(app, agent, path)` | helper | wire a wrapped agent to FastAPI (SSE + `/health`) |

The wrapper is built on the translator; it trades control for less code. The
translator is just an events translator — it does not own your agent or your
server, so start there unless the wrapper's shortcut fits as-is.

`AGUITranslator` pairs with the SDK's streaming run mode:

| Class | Pairs with | `to_agui(...)` returns |
|---|---|---|
| `AGUITranslator` | `Runner.run_streamed` | async iterator of AG-UI events, live |

It is stateless and reusable — each `to_agui` call internally creates the
fresh per-run engine it needs. Create one instance and share it.

### Choose a Pattern

| Need | Use |
|---|---|
| Full control of the agent config and the server (recommended default) | `AGUITranslator` — compose it yourself |
| Just serve a fixed agent over FastAPI, no custom server logic | `OpenAIAgentsAgent` + `add_openai_agents_fastapi_endpoint` |
| Live chat, tool-call progress, reasoning progress | `AGUITranslator` with `Runner.run_streamed` |
| FastAPI SSE | Return `StreamingResponse(_stream(...), media_type="text/event-stream")` |
| WebSocket or another async transport | Iterate `translator.to_agui(result, run_input)` and send each event JSON |
| Custom model settings, tracing, guardrails, handoffs | Pass normal OpenAI Agents SDK args to `Runner.run_streamed` |
| Custom AG-UI mapping behavior | Subclass an engine translator and inject it into the public translator |

## Public API reference

### `AGUITranslator`

`AGUITranslator` is the primary API. It is stateless and reusable: create one
instance for the application, translate each request with `to_openai`, run the
SDK normally, then translate the resulting stream with `to_agui`. It does not
own your SDK agent, server routes, authentication, or session storage.

```python
translator = AGUITranslator()
translated_input = translator.to_openai(run_input)
result = Runner.run_streamed(agent, input=translated_input.messages)

async for event in translator.to_agui(result, run_input):
    yield encoder.encode(event)
```

#### Constructor

```python
AGUITranslator(*, inbound_cls=AGUIToOpenAITranslator, outbound_cls=OpenAIToAGUITranslator)
```

These are advanced extension points for changing one mapping without forking
the public orchestration:

| Parameter | Default | Meaning |
|---|---|---|
| `inbound_cls` | `AGUIToOpenAITranslator` | Class used for AG-UI request → SDK input translation. One instance is reused because it is stateless. |
| `outbound_cls` | `OpenAIToAGUITranslator` | Class used for SDK stream → AG-UI event translation. A fresh instance is created for every run because it tracks open stream windows. |

For normal use, pass neither parameter. For a custom mapping, subclass the
relevant engine class; see [Advanced: the engine layer](#advanced-the-engine-layer).

#### `to_openai(run_input)`

```python
translated_input = translator.to_openai(run_input)
```

Accepts one `RunAgentInput` and returns `TranslatedInput`:

| Field | Use |
|---|---|
| `messages` | Responses API items for `Runner.run_streamed(input=...)`. |
| `tools` | Client-owned `FunctionTool` proxies. Clone the agent and merge these tools for this request. |
| `state`, `context`, `forwarded_props`, `thread_id`, `run_id`, `parent_run_id`, `resume` | Original request data, preserved for your application. |

`TranslatedInput` does not run an agent and does not put `state` or `context`
into prompts automatically.

#### `to_agui(events, run_input, ...)`

```python
async for event in translator.to_agui(result, run_input):
    yield encoder.encode(event)
```

`events` accepts either the `RunResultStreaming` returned by
`Runner.run_streamed` or its `stream_events()` iterator. `run_input` supplies
the lifecycle IDs and message history for snapshots.

| Parameter | Default | Meaning |
|---|---|---|
| `start_custom_event` | `None` | A `CustomEvent` sent after `RUN_STARTED`. |
| `initial_state` | `None` | Static, sync, or async source for an initial `STATE_SNAPSHOT`. |
| `final_state` | `None` | Static, sync, or async source for a final `STATE_SNAPSHOT`. |
| `emit_messages_snapshot` | `True` | Add `MESSAGES_SNAPSHOT` before the terminal event. |
| `end_custom_event` | `None` | A `CustomEvent` sent after the snapshots and before `RUN_FINISHED`. |
| `emit_run_error` | `True` | Send `RUN_ERROR` if streaming raises, then re-raise the original exception. |
| `run_error_message` | `None` | Client-safe error text; by default the event uses `str(exception)`. |

`initial_state` and `final_state` can each be a value, a zero-argument
function, or a zero-argument async function. A supplied `None` skips that
snapshot; an empty `{}` is still a valid snapshot. Custom-event values must be
`CustomEvent` objects. The wrapper supports factories for these events; the
direct translator intentionally accepts the event object for this one run.

Successful runs follow this order:

```text
RUN_STARTED
start_custom_event                 (optional)
STATE_SNAPSHOT                     (initial, optional)
… streamed step, text, tool, and reasoning events …
close any open stream windows
STATE_SNAPSHOT                     (final, optional)
MESSAGES_SNAPSHOT                  (optional, enabled by default)
end_custom_event                   (optional)
RUN_FINISHED
```

If the SDK stream raises, the translator emits `RUN_ERROR` when enabled and
re-raises the original exception. It does not emit final state, a messages
snapshot, `end_custom_event`, or `RUN_FINISHED` on that error path.

### `OpenAIAgentsAgent`

`OpenAIAgentsAgent` is the convenience wrapper for a fixed SDK `Agent`.
Internally it performs the same `to_openai` → `Runner.run_streamed` → `to_agui`
flow shown above. Use it when that standard flow is enough; use
`AGUITranslator` directly when your endpoint needs custom branching,
orchestration, or transport behavior.

```python
wrapped_agent = OpenAIAgentsAgent(
    Agent(name="assistant", instructions="Be concise."),
)
```

| Constructor parameter | Default | Meaning |
|---|---|---|
| `agent` | required | SDK `Agent` to run. |
| `name` | `agent.name` | Public name returned by the helper health route. |
| `description` | `""` | Optional application metadata. |
| `translator` | new `AGUITranslator` | Translator instance, including any custom engine classes. |
| `run_config` | `None` | `RunConfig` passed to every `Runner.run_streamed` call. |
| `start_custom_event` | `None` | A `CustomEvent` or zero-argument factory, emitted after `RUN_STARTED`. |
| `initial_state` | `None` | Same state-source forms as `AGUITranslator.to_agui`. |
| `final_state` | `None` | Same state-source forms as `AGUITranslator.to_agui`. |
| `emit_messages_snapshot` | `True` | Forwarded to `to_agui`. |
| `end_custom_event` | `None` | A `CustomEvent` or zero-argument factory, emitted before the terminal event. |
| `emit_run_error` | `True` | Forwarded to `to_agui`. |
| `run_error_message` | `None` | Forwarded to `to_agui`. |

Call `await` through its async iterator with `run(run_input)`. It yields
`BaseEvent` objects; you encode or transport them yourself unless you use the
FastAPI helper. Client-owned tools are merged onto a clone for that run, so a
tool declared by one request never changes the shared SDK agent or leaks into
another request.

### `add_openai_agents_fastapi_endpoint`

`add_openai_agents_fastapi_endpoint` connects an `OpenAIAgentsAgent` to a
FastAPI app. It is the highest-level option: it owns HTTP POST handling, AG-UI
SSE encoding, and a small health endpoint, but not your agent's own behavior.

```python
app = FastAPI()
add_openai_agents_fastapi_endpoint(app, wrapped_agent, "/assistant")
```

| Parameter | Default | Meaning |
|---|---|---|
| `app` | required | FastAPI application to register routes on. |
| `agent` | required | `OpenAIAgentsAgent` to execute for incoming requests. |
| `path` | `"/"` | POST route that accepts `RunAgentInput`. |

For `path="/assistant"`, the helper registers:

| Route | Behavior |
|---|---|
| `POST /assistant` | Runs the wrapper and returns encoded AG-UI SSE events. |
| `GET /assistant/health` | Returns `{"status": "ok", "agent": {"name": ...}}`. |

The helper uses the request `Accept` header when creating `EventEncoder`, so
its response content type matches AG-UI content negotiation. It adds routes
only; it does not start a server or manage sessions.

### Streaming: Live AG-UI Output

AG-UI is an ordered event stream by design, so streaming is the primary mode:

```python
translator = AGUITranslator()

translated_input = translator.to_openai(run_input)
result = Runner.run_streamed(agent, input=translated_input.messages)

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
    input=translated_input.messages,
    context=my_context,
    max_turns=8,
    run_config=run_config,
)

async for event in translator.to_agui(result, run_input):
    ...
```

### What `to_openai` gives you

`TranslatedInput` mirrors `RunAgentInput` field for field:

| AG-UI field | Lands in |
|---|---|
| `messages` | `translated_input.messages` — Responses-API input items for `Runner.run_streamed` |
| `tools` | `translated_input.tools` — SDK `FunctionTool` proxies for client-declared tools; merge with `agent.clone(tools=[*agent.tools, *translated_input.tools])` |
| `state`, `context`, `forwarded_props` | passthrough — the direct translator never injects them into model input; use them in your application as needed |
| `thread_id`, `run_id`, `parent_run_id`, `resume` | passthrough |

The most important field is `translated_input.messages`; pass it as `input=` to
`Runner.run_streamed`.

If `translated_input.tools` is non-empty, merge those tools into the agent for this
request:

```python
run_agent = agent
if translated_input.tools:
    run_agent = agent.clone(tools=[*agent.tools, *translated_input.tools])
```

### Lifecycle Events

`to_agui` always wraps the stream: `RUN_STARTED` is the first event
yielded, and `RUN_FINISHED` is the last — or `RUN_ERROR` if the stream
raises, in which case the exception is re-raised after that event so your
own logging/observability still sees it. This covers `asyncio.CancelledError`
too (a mid-stream timeout or dropped connection), not just ordinary
exceptions — it's `BaseException`, not `Exception`, so a plain
`except Exception` would miss it and the client would just see the
stream stop with no `RUN_ERROR` and no `RUN_FINISHED`. `RUN_STARTED` and
`RUN_FINISHED` are not optional — every caller needs them, so there's no
flag to turn them off:

```python
async for event in translator.to_agui(result, run_input):
    yield encoder.encode(event)
```

`thread_id`/`run_id` come straight off `run_input` — no separate params to
pass, since `run_input` is already required for the lifecycle events (and,
by default, the snapshot).

The `RUN_ERROR` on the error path is tunable. By default it carries
`str(exc)`; pass `run_error_message` to send a fixed string instead, so raw
exception text never reaches the client — the real exception is still
re-raised, so your own logging keeps it:

```python
async for event in translator.to_agui(
    result, run_input, run_error_message="Agent run failed"
):
    yield encoder.encode(event)
```

Pass `emit_run_error=False` only if you emit your own terminal error event
in an outer handler — otherwise the exception re-raises with no `RUN_ERROR`
and the client just watches the stream stop.

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
backends that don't stamp real ids. Reasoning items
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
| `STATE_SNAPSHOT` | `to_agui` when you provide `initial_state` and/or `final_state` |
| `MESSAGES_SNAPSHOT` | `to_agui` (on by default; pass `emit_messages_snapshot=False` to own it yourself) |
| Session storage and thread history | Your server |
| SSE, WebSocket, HTTP response shape | Your server/framework |
| OpenAI agent choice, model settings, handoffs, guardrails | Your OpenAI Agents SDK code |
| AG-UI message/tool/event shape conversion | This package |

This keeps the integration framework-neutral. FastAPI, Starlette, Django,
aiohttp, raw ASGI, WebSockets, or tests can all use the same translator calls.

### Event Mapping

Both directions, source of truth is `engine/agui_to_openai.py` and
`engine/openai_to_agui.py`.

**Inbound** — AG-UI `Message` → Responses-API input item (`AGUIToOpenAITranslator`):

| AG-UI type | SDK / Responses-API shape |
|---|---|
| `UserMessage` | `{"type": "message", "role": "user", "content": [...]}` (multimodal-aware) |
| `SystemMessage` | `{"type": "message", "role": "system", ...}` |
| `DeveloperMessage` | `{"type": "message", "role": "developer", ...}` |
| `AssistantMessage` | optional text `message` item + one `function_call` item per `tool_calls` entry |
| `ToolMessage` | `{"type": "function_call_output", "call_id": ..., "output": ...}` |
| `ReasoningMessage` | `{"type": "reasoning", ...}` if `encrypted_value` is set, else dropped (plaintext reasoning isn't replayable) |
| `ActivityMessage` | dropped (no Responses-API equivalent; override to fold into the prompt) |
| `Tool` (client-declared) | SDK `FunctionTool` proxy that raises `ClientToolPending` when invoked |
| Content parts: `TextInputContent`, `ImageInputContent`, `AudioInputContent`, `DocumentInputContent`, `BinaryInputContent` | `input_text` / `input_image` / `input_audio` / `input_file` parts |
| `VideoInputContent` | dropped (no OpenAI API accepts video input yet) |

**Outbound** — SDK stream event → AG-UI `BaseEvent` (`OpenAIToAGUITranslator`):

| SDK event / item | AG-UI event(s) |
|---|---|
| `response.output_item.added` (message) | `TEXT_MESSAGE_START` |
| `response.output_text.delta` / `response.refusal.delta` | `TEXT_MESSAGE_CONTENT` (lazy-opens the window if needed) |
| `response.output_item.done` (message) / `response.output_text.done` | `TEXT_MESSAGE_END` |
| `response.output_item.added` (function_call / hosted tool call) | `TOOL_CALL_START` |
| `response.function_call_arguments.delta` | `TOOL_CALL_ARGS` |
| `response.output_item.done` (function_call / hosted tool call) | `TOOL_CALL_END` |
| `ToolCallOutputItem` | `TOOL_CALL_RESULT` |
| `HandoffCallItem` | `TOOL_CALL_START` / `TOOL_CALL_ARGS` / `TOOL_CALL_END` (a handoff is a function call) |
| `HandoffOutputItem` | `TOOL_CALL_RESULT` |
| `response.reasoning_summary_text.delta` / `response.reasoning_text.delta` | `REASONING_START` (once) + `REASONING_MESSAGE_START` + `REASONING_MESSAGE_CONTENT` |
| `response.reasoning_summary_part.done` / `response.reasoning_text.done` | `REASONING_MESSAGE_END` |
| `ReasoningItem` (finished, with `encrypted_content`) | `REASONING_ENCRYPTED_VALUE` |
| stream end / any open reasoning when text or a tool call opens | `REASONING_END` |
| `AgentUpdatedStreamEvent` | `STEP_FINISHED` (previous agent, if any) + `STEP_STARTED` (new agent) |
| `MCPApprovalRequestItem` | `CUSTOM` (name=`"mcp_approval_request"`) |
| `MCPListToolsItem`, `MCPApprovalResponseItem` | dropped (server-side bookkeeping / echo) |
| stream start / end (always, via `to_agui`) | `RUN_STARTED` / `RUN_FINISHED` (or `RUN_ERROR`) |
| end of stream, `run_input` given (default) | `MESSAGES_SNAPSHOT` |
| `initial_state` / `final_state`, if provided | `STATE_SNAPSHOT` |

Unknown SDK event or item types translate to `[]` with a debug log —
graceful degradation, never a raise. See `tests/test_engine_mapping.py` for
the streaming behavior pinned event-by-event.

### Guardrails

The AG-UI protocol has no guardrail event type, so guardrails surface as
run errors. When an input or output guardrail trips, the OpenAI Agents SDK
raises `InputGuardrailTripwireTriggered` / `OutputGuardrailTripwireTriggered`
mid-run; that exception flows through the stream, `to_agui` yields
`RUN_ERROR`, and re-raises. No special handling needed — a tripwire aborts
the run like any other error.

Guardrail messages can be noisy or leak your policy internals, so this is a
natural place for `run_error_message` — send a clean, client-safe string
while your logs keep the real exception:

```python
async for event in translator.to_agui(
    result, run_input, run_error_message="Request blocked by content policy"
):
    yield encoder.encode(event)
```

### Multi-modality

**Input (what the user sends the agent):** an AG-UI `UserMessage` can carry
more than text — images, audio clips, documents, etc. Each one is a typed
content part (`ag_ui.core.InputContent`). The translator converts each part
into the block shape the OpenAI Agents SDK expects for that message:

| User sends this... | ...becomes this for the SDK | How |
|---|---|---|
| Plain text | `input_text` | as-is |
| An image | `input_image` | a URL is passed through; raw bytes become a base64 `data:` URL |
| An audio clip | `input_audio` | must be raw bytes (base64) — audio can't be sent as a URL; the audio format (`wav`, `mp3`, ...) is read from the clip's mime type |
| A document (PDF, etc.) | `input_file` | URL stays a URL; raw bytes become base64 |
| A video | *(dropped, see below)* | not supported — see below |
| `BinaryInputContent` (deprecated, legacy catch-all) | whichever of the above matches its mime type | e.g. `image/*` → `input_image` |

**Video input isn't supported, and it's not our limitation to fix.** Right
now, no OpenAI API (Responses or Chat Completions) accepts video as input at
all — there's no video content type to translate into. If OpenAI adds one,
we'll wire it up. Until then, video parts are silently dropped (logged, not
an error). If you want to work around it today, override
`translate_video_content` in a subclass — e.g. extract a few frames and send
them as images instead.

**Output (what the agent sends back):** text only. If the agent generates an
image, audio, or speaks out loud (TTS), none of that reaches the AG-UI
client — the AG-UI protocol itself has no event type for "here's an image/audio
clip the model produced," so there's nothing to translate it into. This is a
protocol-level gap, not something specific to this integration — every
AG-UI SDK has the same hole.

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
translated_input = translator.to_openai(run_input)

instructions = agent.instructions
if translated_input.context:
  instructions += "\n\nContext:\n" + "\n".join(
    f"- {item.description}: {item.value}" for item in translated_input.context
  )

run_agent = agent.clone(instructions=instructions)
result = Runner.run_streamed(run_agent, input=translated_input.messages)
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

- `AGUIToOpenAITranslator` — inbound; stateless, tiered per-type methods
  (`translate_user_message`, `translate_tool_message`, ...)
- `OpenAIToAGUITranslator` — outbound; stateful per run (open text/tool/reasoning
  windows), per-type methods (`translate_text_delta`, `translate_item`, ...)

Every per-type method is a public override point. To customize one mapping,
subclass the engine and inject it — the public translator and every other mapping stay
untouched:

```python
from ag_ui_openai_agents import AGUITranslator
from ag_ui_openai_agents.engine import OpenAIToAGUITranslator


class MyOutbound(OpenAIToAGUITranslator):
    def translate_text_delta(self, data):
        ...  # your variant of one mapping

translator = AGUITranslator(outbound_cls=MyOutbound)
```

## Frontend (client-owned) tools & Human-in-the-Loop

Tools declared in `RunAgentInput.tools` belong to the **frontend** — the
browser owns their execution (rendering UI, waiting on the user), not your
server. This is the human-in-the-loop mechanism: the same one most AG-UI
integrations use, paired with CopilotKit's `useHumanInTheLoop` on the client.

**1. Merge the client tools onto your agent per request.** `to_openai` turns
each into an SDK `FunctionTool` proxy:

```python
translated = translator.to_openai(run_input)
agent = base_agent.clone(tools=[*base_agent.tools, *translated.tools])
```

**2. Stop the run when the model calls one.** Use the SDK-native
`StopAtTools` so the run ends the instant the model emits the call — before
the (never-used) proxy body would run:

```python
from agents import Agent, StopAtTools

base_agent = Agent(
    ...,
    tool_use_behavior=StopAtTools(stop_at_tool_names=["generate_task_steps"]),
)
```

**3. The frontend answers; the agent resumes next request.** The tool call
streams to the browser, the user acts, and the result comes back as a
`ToolMessage` in the next run's `messages` — ordinary multi-turn history.
`to_openai` translates that `ToolMessage` into a `function_call_output`, so the
agent picks up where it left off. No custom event, no `RunState`, no
persistence to wire.

```
Request 1:  user asks  →  agent calls generate_task_steps  →  RUN_FINISHED (paused)
Frontend:   renders the call, user approves/edits
Request 2:  messages include the ToolMessage result  →  agent continues
```

See `examples/agents_examples/human_in_the_loop.py` for the agent and
`examples/server.py` for the run loop that merges the client tools.

## Backend tool approval (`needs_approval`)

Different from the frontend-tools pattern above: here the tool is real
server-side code (`@function_tool`, `Agent.tools=[...]`), and the SDK itself
gates it with `needs_approval=True` — no AG-UI concept involved. This is for
"the backend can do this, but a human should sign off first" (e.g. issuing a
refund), as opposed to "only the browser can do this at all".

|  | Frontend tools (above) | Backend approval (here) |
|---|---|---|
| Tool implementation | None — frontend-only | Real, server-side |
| Pause mechanism | `StopAtTools`, mid-stream | `needs_approval`, only known post-stream via `result.interruptions` |
| Decision carried back as | An ordinary `ToolMessage` next turn | `forwarded_props["approval"]` + a stored `RunState` |
| Dojo demo | `human_in_the_loop` | `human_in_the_loop_approval` |

**1. Mark the tool.** The SDK stops the run before the body executes and
reports the pending call on `result.interruptions`:

```python
from agents import function_tool

@function_tool(needs_approval=True)
def issue_refund(order_id: str) -> str:
    ...  # real logic — only runs after approval
```

**2. `result.interruptions` is only known post-hoc — and the client drops
anything sent after `RUN_FINISHED`.** So the approval event can't be a
plain event yielded after the `to_agui()` loop; it has to be
`end_custom_event` (fires right before `RUN_FINISHED`), which means
draining the raw SDK stream yourself first instead of handing `result`
straight to `to_agui`:

```python
raw_events = [event async for event in result.stream_events()]

end_custom_event = None
if result.interruptions:
    state = result.to_state()          # serialize the paused run
    store[run_input.thread_id] = state  # keep it somewhere until the decision arrives
    end_custom_event = CustomEvent(
        name="approval_request",
        value=[
            {"call_id": item.raw_item.call_id, "tool_name": item.tool_name}
            for item in result.interruptions
        ],
    )

async def _replay():
    for event in raw_events:
        yield event

async for ag_event in translator.to_agui(_replay(), run_input, end_custom_event=end_custom_event):
    yield encoder.encode(ag_event)
```

**3. Resume from the stored state on the next request**, once the client
sends the decision back (however you choose to carry it — e.g.
`forwarded_props`):

```python
state = store.pop(run_input.thread_id)
item = next(i for i in state.get_interruptions() if i.raw_item.call_id == call_id)
state.approve(item) if approve else state.reject(item)
result = Runner.run_streamed(agent, state)   # resumes, not a fresh run
```

There's no AG-UI-native event for the approval request — `CustomEvent` is
the same escape hatch used for MCP approval requests elsewhere in this
package. See `examples/agents_examples/human_in_the_loop_approval.py` for
the agent and `examples/server.py` (`/human_in_the_loop_approval`) for the
full hand-routed loop, including the in-memory pending-state store.

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
`engine/types.py`), and the guard asserts each one against the
`Literal[...]` annotations of the installed `openai-agents` / `openai`
packages. After bumping either dependency, run `uv run pytest` — if a wire
type was renamed or a new hosted tool-call item type was added, the guard
fails with an assertion diff naming the exact value to update in
`types.py`. Unknown types never crash at runtime (the translator
degrades gracefully and skips them); the guard exists so drift is caught in
CI instead of silently dropping events.

# ag-ui-langgraph

Implementation of the AG-UI protocol for LangGraph.

Provides a complete Python integration for LangGraph agents with the AG-UI protocol, including FastAPI endpoint creation and comprehensive event streaming.

## Media inputs

Non-image attachments keep their LangChain content type: audio becomes `audio`,
video becomes `video`, and documents become `file`. Inline bytes, base64 data URLs,
and remote URLs retain their payload and supplied filename; the adapter does not
fetch URLs. Images continue to use `image_url`; a supplied image filename is
recorded on the user message as `additional_kwargs["ag-ui"]["attachments"]`
(block index, block type and filename), because the `image_url` block has no
field providers accept for it, and is restored onto the same part when the
thread is read back.

Conversion does not imply model support. The graph's provider, model, and API
must support the supplied media type and source. Unsupported input is reported
as a `RUN_ERROR`; it is not relabeled as an image. Existing inline WAV/MP3 MIME aliases
are normalized for compatibility, while other audio MIME types remain unchanged.
Provider file handles remain unsupported and are skipped with a warning.

## Run errors

Graph/provider and stream failures are delivered by the public `run()` async
iterator as a terminal `RUN_ERROR` event, followed by stream completion without
`RUN_FINISHED`. This also applies to text-only runs. Inspect the yielded error
event instead of relying on these producer exceptions escaping the iterator.
Cancellation still propagates, and private stream helpers retain their exception
behavior.

For TypeScript AG-UI clients consuming this stream, handle producer failures in
`onRunErrorEvent` when using `runAgent()`, or inspect the emitted `RUN_ERROR` when
subscribing to `run()`. These producer failures no longer reject the `runAgent()`
promise or invoke the Observable's `error` callback. Consumer and client-side
validation failures retain their existing error behavior.

## Installation

```bash
pip install ag-ui-langgraph
```

## Usage

```python
from langgraph.graph import StateGraph, MessagesState
from langchain_openai import ChatOpenAI
from ag_ui_langgraph import LangGraphAgent, add_langgraph_fastapi_endpoint
from fastapi import FastAPI
from my_langgraph_workflow import graph

# Add to FastAPI
app = FastAPI()
add_langgraph_fastapi_endpoint(app, graph, "/agent")
```

## Features

- **Native LangGraph integration** – Direct support for LangGraph workflows and state management
- **FastAPI endpoint creation** – Automatic HTTP endpoint generation with proper event streaming
- **Advanced event handling** – Comprehensive support for all AG-UI events including thinking, tool calls, and state updates
- **Message translation** – Seamless conversion between AG-UI and LangChain message formats

## Resuming via AG-UI standard `resume[]`

The client sends `RunAgentInput.resume = [ResumeEntry, ...]`. The integration converts the
array into a single `Command(resume=...)` value (LangGraph's resume
channel is per-task, not per-interrupt). The shape your graph receives:

- **Single `resolved` entry** → `interrupt()` returns `entry.payload`
  verbatim. Existing graphs that consumed `Command(resume=<payload>)`
  keep working.
- **Single `cancelled` entry** → `interrupt()` returns the sentinel
  `{"__agui_cancelled__": true, "interrupt_id": "..."}`.
  Your graph should branch on this key.
- **Multiple entries** (parallel interrupts) → `interrupt()` returns
  `{"__agui_resume_map__": { interruptId: {status, payload}, ... }}`.

These sentinels live in the AG-UI integration only — they do **not**
leak into transport-level events.

## Migrating to AG-UI 1.0 interrupts

Interrupted runs always end with `RUN_FINISHED.outcome.type = "interrupt"`.
Read `outcome.interrupts` and echo each interrupt's `id` as `interruptId` in
`RunAgentInput.resume[]`. The original LangGraph value remains in
`interrupt.metadata.langgraph.raw`; subagent attribution stays on the interrupt.
No opt-in is required.

```python
from ag_ui.core import ResumeEntry, RunAgentInput

input = RunAgentInput(
    thread_id="t1", run_id="r2", messages=[], state={}, tools=[], context=[],
    forwarded_props={},
    resume=[ResumeEntry(interrupt_id="int-abc", status="resolved", payload={"approved": True})],
)
```

This is a breaking client migration:

- `CUSTOM(name="on_interrupt")` is no longer emitted.
- `forwardedProps.command.resume` is no longer consumed as a resume directive.
  It cannot clear pending interrupts or bypass resume validation.
- `enableLegacyOnInterruptEvent` / `enable_legacy_on_interrupt_event` and
  `emitInterruptOutcome` / `emit_interrupt_outcome` have been removed.
- TypeScript's `isLegacyCommandResume` and `reconcileLegacyResumeInterrupts`
  exports have been removed, including the `LangGraphHttpAgent` lifecycle bridge.
- Retired `binary` input parts are no longer converted. Send `image`, `audio`,
  `video`, or `document` with a typed `source` (`url`, `data`, or provider `file`).

Upgrade client code before adopting this adapter. Clients whose interrupt hooks
only listen for `on_interrupt` must move to structured outcomes and `resume[]`.
Python requires `ag-ui-protocol>=1.0` and `langgraph>=1.0.2,<2`; the 1.0.2
floor matches the existing `langchain>=1.2.0` dependency. TypeScript requires
`@ag-ui/core` and `@ag-ui/client` 1.0 or later.

LangGraph's native `interrupt()` and `Command(resume=...)` remain unchanged.
The adapter translates canonical resume entries into that native command,
including cancellation and multiple-entry sentinels described above. Existing
checkpoint replay and persisted-session handling remain supported.

### Capabilities

`LangGraphAgent.get_capabilities()` returns `{"humanInTheLoop": {"supported": True, "interrupts": True, "approveWithEdits": True}}`.

### Customising the HITL bridge (subclass hooks)

If your graph uses a middleware whose interrupt value carries structured payloads (e.g. LangChain's `HumanInTheLoopMiddleware` with `action_requests` / `review_configs`), you can override two protected methods instead of monkey-patching the run loop:

```python
from ag_ui_langgraph import LangGraphAgent
from ag_ui_langgraph.interrupts import lg_interrupt_to_agui
from ag_ui.core import Interrupt as AGUIInterrupt
from langgraph.types import Command

class HITLLangGraphAgent(LangGraphAgent):
    def _interrupts_to_agui(self, lg_interrupts):
        out = []
        for lg in lg_interrupts:
            value = lg.value
            if isinstance(value, dict) and "action_requests" in value:
                out.extend(my_action_requests_to_agui(value))
            else:
                out.append(lg_interrupt_to_agui(lg))
        return out

    def _build_command_from_agui_resume(self, entries, *, open_interrupts=None):
        return Command(
            resume=my_resume_to_decisions(entries, open_interrupts),
        )
```

The base class still handles `STATE_SNAPSHOT` / `MESSAGES_SNAPSHOT` ordering, legacy `CustomEvent(on_interrupt)` emission, the `prepare_stream` short-circuit, and `forwarded_props.command.resume` deprecation — your subclass only needs to care about the HITL-specific translation.

## To run the dojo examples

```bash
cd python/ag_ui_langgraph/examples
poetry install
poetry run dev
```

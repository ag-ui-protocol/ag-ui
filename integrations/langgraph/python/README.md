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

The client sends `RunAgentInput.resume = [ResumeEntry, ...]`. Before starting
or updating the graph, the adapter checks each `interruptId` against the open
interrupts in the checkpoint. Unknown, stale, and duplicate IDs produce a run
error without applying an answer, including after reconnecting with a fresh agent.

The adapter builds LangGraph's native `Command(resume={interruptId: answer, ...})`
map for both single and parallel interrupts. Each resolved interrupt receives its
own `entry.payload` verbatim, including falsy values. A cancelled interrupt receives
`{"__agui_cancelled__": true, "interrupt_id": "..."}`; the graph should branch on
this integration-specific sentinel. Multiple answers are not wrapped in
`__agui_resume_map__`. See [LangGraph's parallel-interrupt documentation](https://docs.langchain.com/oss/python/langgraph/interrupts#handling-multiple-interrupts).

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
Python requires `ag-ui-protocol>=1.0` and `langgraph>=1.0.10,<2`. The framework
floor makes the 1.0.10 opt-in checkpoint hardening available and supports the existing
`langchain>=1.2.0` dependency. TypeScript requires
`@ag-ui/core` and `@ag-ui/client` 1.0 or later.

LangGraph's native `interrupt()` and `Command(resume=...)` remain unchanged.
The adapter translates canonical resume entries into that native command,
including cancellation and ID-addressed parallel answers described above. Existing
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

The base class handles snapshot ordering, canonical interrupt outcomes, and resume preparation; subclasses only translate their native interrupt values and decisions.

## To run the dojo examples

```bash
cd python/ag_ui_langgraph/examples
poetry install
poetry run dev
```

## Framework support policy

The Python adapter supports `langgraph>=1.0.10,<2` (Python 3.10–3.14).
The adapter also requires AG-UI SDK 1.0 or later and canonical interrupt
clients, as described above.

As of October 7, 2026, the old 0.6.0 floor was over fourteen months old
([PyPI release metadata](https://pypi.org/pypi/langgraph/0.6.0/json)).
LangGraph 1.0 shipped in October 2025, and 1.0.10 shipped on February 27,
2026, over seven months ago
([release metadata](https://pypi.org/pypi/langgraph/1.0.10/json)). The existing
`langchain>=1.2.0` dependency already requires LangGraph 1.x; the previous
0.6.0 declaration overstated the installable support range.

We chose 1.0.10 over the earliest compatible 1.0.2 because it includes the
checkpoint-deserialization hardening described in
[GHSA-g48c-2wqr-h844](https://github.com/langchain-ai/langgraph/security/advisories/GHSA-g48c-2wqr-h844).
This version floor makes the protection available; it does not enable it.
The default msgpack policy still allows unlisted types with a warning. Deployments
loading persisted checkpoints must opt in with `LANGGRAPH_STRICT_MSGPACK=true`
or configure their serializer's `allowed_msgpack_modules` with an explicit
allowlist (`None` selects the built-in safe set). Verify the chosen checkpointer
supports allowlist enforcement, particularly with custom serializers; custom
unpack hooks can bypass the policy. The adapter does not change these settings
or rewrite saved checkpoints.
We did not choose the latest 1.2 release just for recency: this cleanup needs
no 1.1/1.2-only API. Version-specific usage-share evidence was unavailable;
release age is not a claim of broad adoption.

The [upstream v1 migration guide](https://docs.langchain.com/oss/python/migrate/langgraph-v1)
describes a largely backward-compatible release. Python 3.9 removal adds no
new restriction here because this adapter already requires Python 3.10.
Applications must update any explicit pre-floor framework pins and resolve
their provider/checkpointer dependencies together. Custom graph wrappers
must forward `context` (usually through `**kwargs`) to `astream_events`;
the adapter no longer probes old signatures and silently drops context.
The old `langchain.schema` import attempt is also removed, since the already
required LangChain 1.x exposes messages through `langchain_core.messages`.

The framework CI matrix runs the full suite at the declared minimum and
locked current LangGraph versions, each with the minimum and locked AG-UI
SDK. Real compiled-graph tests exercise context precedence and checkpoint
resume with a false decision. Provider conversions, persisted-history
migrations and schema fallbacks for custom graphs remain supported. Legacy
interrupt wire/client compatibility is retired; see the migration notes above.
The isolated TypeScript examples retain their published adapter pin.

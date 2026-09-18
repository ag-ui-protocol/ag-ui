# Native Python Copilot SDK → AG-UI

Community integration; not an official GitHub-supported SDK surface.

## Self-contained server (no sibling repository required)

```bash
cd integrations/copilot-sdk/python
uv run --extra server python examples/server.py
# Equivalent module: uv run --extra server python -m ag_ui_copilot_sdk.server
# Equivalent installed entrypoint: uv run --extra server ag-ui-copilot-server
```

Defaults: `HOST=127.0.0.1`, `PORT=8123`, `COPILOT_MODEL=auto`.
`GET /health`, `POST /agent` (AG-UI JSON → SSE), and `POST /cancel`
(`{"threadId":"..."}`) are available. Set `PORT` to avoid another local backend.
Local SDK storage uses private (mode `0700`) `.runtime/sdk-<id>/` directories
under the working directory. Each server owns and removes only its own directory
after SDK shutdown, including startup failures; existing host files are preserved.
`HOST=0.0.0.0` explicitly opts into network binding. This unauthenticated demo
is not a production service; use a trusted network or authenticated gateway.
The optional `server` extra supplies Starlette/Uvicorn; the core mapper and
adapter do not require an HTTP framework.

This minimal server supports native chat and `input.tools` frontend declarations,
including original pending-tool continuation. It deliberately has **no**
application-specific backend tools, shell, or arbitrary host access. It is suitable
for Dojo `agentic_chat` registration first; it does not claim other Dojo feature
pages whose schemas require unrelated application tools.

For offline Dojo CI, select the explicitly synthetic mode:

```bash
cd integrations/copilot-sdk/python
COPILOT_DEMO_MODE=fixture HOST=127.0.0.1 PORT=8027 \
  uv run --extra server python examples/server.py
```

`GET /health` reports `"mode":"fixture","synthetic":true`. This injects a fake
SDK client/session that emits deterministic, incremental native-shaped greeting
events through the **same `CopilotAgent` and `EventMapper`**. It never constructs
the native runtime/auth client, injects a fake token, accesses credentials, or
calls a model. Listener/task cancellation and normal HTTP bounds still apply.
It covers `agentic_chat` only: no synthetic claims about backend tools,
frontend-tool execution, reasoning, subagents, or broader Dojo features.
The default is `COPILOT_DEMO_MODE=live` with the real managed SDK; unsupported
mode values fail explicitly rather than unexpectedly invoking a model.

Applications can add backend tools and state through
`create_app(tools_factory=..., state_validator=...)`, reusing this server's request
validation and lifecycle instead of copying HTTP code.

## Install and verify

```bash
cd integrations/copilot-sdk/python
uv sync --locked --extra server
uv run --locked --extra server pytest -q
uv run --locked --extra server ruff check .
uv build
```

Python ≥3.11. Protocol types pin published `ag-ui-protocol==0.1.22`, including
canonical child lifecycle and readable reasoning. The lock pins `github-copilot-sdk==1.0.14`, whose matching managed
runtime is 1.0.85. The official PyPI wheel URL in `pyproject.toml` works around
an index that did not yet expose this release. No global CLI replacement is needed.
There is no Nx Python project target in this new package; use the `uv` commands above.

## Public API

```python
from pathlib import Path

from ag_ui.encoder import EventEncoder
from ag_ui_copilot_sdk import CopilotAgent
from copilot import CopilotClient

async def serve(run_input):
    storage = Path(".runtime").resolve()
    storage.mkdir(exist_ok=True)
    client = CopilotClient(
        mode="empty",
        base_directory=str(storage),
        use_logged_in_user=True,
        log_level="error",
    )
    await client.start()
    agent = CopilotAgent(client, model="auto")
    try:
        async for event in agent.run(run_input):
            yield EventEncoder().encode(event)
    finally:
        await agent.close()
        await client.stop()
```

**Retain the client and agent at application scope**, not per HTTP request, when
using browser tools or conversation history. The short example demonstrates
resource ownership only. The self-contained `ag_ui_copilot_sdk.server` entrypoint
above owns resources at application scope and requires no external sample.
The caller starts/stops its client; `agent.close()` closes all retained sessions.
Call the stream's `aclose()` on HTTP disconnect, and `agent.cancel(thread_id)` to
discard an active run or pending handoff.

- `CopilotAgent.run(RunAgentInput | Mapping) -> AsyncIterator[BaseEvent]`.
- `EventMapper().map_event(sdk_event.to_dict()) -> list[BaseEvent]`.
- `EventMapper.finish(cancelled=False) -> list[BaseEvent]` closes open text and
  readable reasoning blocks. It **never** invents a tool result or run terminal.
- `tools_factory(ThreadContext) -> list[copilot.tools.Tool]` supplies application
  backend tools. `ThreadContext.emit()` accepts application-owned typed events.
- `state_validator(current, incoming) -> JSON state` validates UI state at the
  boundary before any SDK work; state does not come from invented SDK events.
- Serialize typed events with AG-UI's `EventEncoder`, or
  `event.model_dump(mode="json", by_alias=True, exclude_none=True)`.

## Frontend continuation ownership

`input.tools` become declaration-only native SDK tools, without handlers.
The adapter subscribes through the **keyword-only** `create_session(on_event=...)`
so early events cannot be missed.

1. The native runtime emits `external_tool.requested`.
2. The adapter owns the mapping from thread + tool-call ID to the original
   request ID and SDK session. Client-supplied pending request/session IDs are ignored.
3. `TOOL_CALL_START/ARGS/END` precede handoff `RUN_FINISHED`, with **no result**.
4. The same live session remains attached during the browser handoff.
5. A subsequent request starts a new AG-UI run and resolves the original
   `HandlePendingToolCallRequest` using its tool-role messages.
6. The SDK continues the original model conversation; continuation never calls
   `session.send`, reinjects a prompt, or resends the browser transcript.
   The browser already owns its `ToolMessage`: echoed native completion does
   **not** produce another `TOOL_CALL_RESULT`. Backend tool results still do.

This is ordinary frontend-tool continuation, **not** an AG-UI interrupt:
handoff `RUN_FINISHED` has no interrupt outcome and clients do not send `resume[]`.
Registered parked tools remain available when the continuation omits their
declarations. Removing a declaration does not orphan the original pending RPC.

Parallel requests are retained in a map. Out-of-order and partial result batches
are supported; partial batches finish another handoff rather than hang. Identical
duplicates are idempotent. Conflicting duplicates, missing results, changed tool
declarations, unknown/stale calls, wrong-thread results, and overlapping requests
on one thread fail explicitly. Independent threads proceed concurrently.
Changed answers use stable `FRONTEND_TOOL_RESULT_CONFLICT`; exact replay never
starts another model turn, even while another result remains parked. Legitimate
source events that arrived late are still delivered rather than discarded.
Normal new turns send only the latest new text user message plus validated
application state. Multimodal inputs and arbitrary browser history seeding are
not supported.

The experimental pending-tool RPC is isolated in `_resolve`; changing the pinned
SDK requires rerunning the real native probes.

## Event fidelity and activity contract

Text deltas and final-only messages use stable IDs and do not duplicate final
text. Tool argument deltas are buffered until the authoritative invocation/name,
then emitted as arguments; they are **never stdout**.
Native `tool.execution_partial_result.data.partialOutput` supplies activity output
during execution; progress is separate. Completion uses authoritative SDK
`result.content`, including native shell trailers, rather than alternate
`detailedContent` or another copy of streamed output. An
empty final display retains existing partial output. Explicitly empty tool
results remain empty, including failed invocations; status and native shell exit
codes still identify failures and cancellation.
Native shell (`bash`/`powershell`, or SDK `shellToolInfo`) partials replace the
previous cumulative output snapshot; non-shell partials append as chunks.
Command text comes from `shellToolInfo.displayCommand`, falling back to actual
`arguments.command` only for native shell tools. Output prefixes never determine
whether a tool uses snapshots or chunks; no stdout/stderr split is invented.
Runtime 1.0.85 can emit `success: true` for a shell process exiting nonzero:
the activity correctly reports `error` for that exit code.

```json
{
  "type": "ACTIVITY_SNAPSHOT",
  "messageId": "activity:<toolCallId>",
  "activityType": "copilot-sdk:tool",
  "content": {
    "toolCallId": "<toolCallId>",
    "toolName": "bash",
    "status": "running",
    "arguments": {},
    "command": "optional native display command",
    "output": "",
    "progress": "optional progress message",
    "exitCode": 0,
    "truncated": false,
    "parentToolCallId": "optional actual parent tool"
  }
}
```

Optional fields are omitted when absent. Status is
`running | completed | error | cancelled`. Output is plain text; the UI must
escape it, not interpret HTML/ANSI. Output/result truncation is marked.
Explicit host-produced activity is supported separately: the sample's safe
delayed command fixture reports its own real output, not fabricated SDK events.

Child activity uses `activityType: "copilot-sdk:subagent"`, message ID
`subagent:<toolCallId>`, and content
`{toolCallId, agentName, status, description?, parentToolCallId?}`.
Actual `subagent.started` correlates envelope `agentId` with its spawning
`data.toolCallId`; that association scopes child messages/tools. The chronological
envelope `parentId` is **never** ancestry, and the child's own `agentId` is not
invented as its parent.

**Child-owned frontend handoff is not yet supported.** The published verifier
requires all canonical child runs to close before `RUN_FINISHED`. Treating a
child as `suspended` beneath a successful frontend handoff is an inference, not
a verified CopilotKit contract. Such a request fails explicitly with
`SUBAGENT_FRONTEND_HANDOFF_UNSUPPORTED` and closes the child as an error, rather
than emitting a contradictory or unclosed successful trace. Ordinary native
child execution, scoped streaming, and completion remain supported.

Readable native reasoning uses `REASONING_START`, `REASONING_MESSAGE_*`,
`REASONING_END`, including orphan closure. No opaque/encrypted reasoning, raw
events, auth data, diagnostics, usage payloads, filesystem snapshots, or model
request internals are forwarded. Unsupported SDK events are deliberately omitted.

## Bounds and lifecycle

Defaults: 32 warm threads, 15-minute idle/pending TTL, 180-second run deadline,
256 queued events/thread, 256 KiB/event, 64 Ki characters/message, argument or
retained tool output, 4096 retained entities/session, 20,000 deduplication event
IDs/native user turn, 1 MiB input, 1000 messages and
64 frontend tools/request. Exceeding a bound fails rather than silently losing
text. Terminal SDK errors become one sanitized `RUN_ERROR`, not an additional
`RUN_FINISHED`. Abort/disconnect/expiry/shutdown release listeners and abort and
disconnect owned SDK sessions. SDK-managed tool coroutines must cooperate with
`asyncio.CancelledError`.
Normal completed handoff SSE leaves the parked session alive; an active
disconnect cancels. Explicit Stop must call `cancel(thread_id)`, including
after the handoff stream has ended. The sample exposes `POST /cancel`
(also `/agent/cancel`) with `{"threadId":"..."}` for this purpose.

Retention is **in-process only**. `.runtime/` may contain sensitive local SDK
session data and is ignored by Git; the bundled server removes its owned private
subdirectory on shutdown. The presence of SDK session files does not
provide durable adapter ownership or restart recovery. Stale frontend results
after restart/expiry are rejected, never started as a new conversation.

Event deduplication resets for a new native user turn, not for a frontend
continuation. Its budget is independent of retained message/tool/child entities:
thousands of deltas do not consume thousands of entity slots. Exhaustion fails
explicitly; the adapter never silently creates a replacement conversation.
If a final text suffix arrives after handoff closed its original AG-UI message,
the suffix is emitted under a fresh message segment instead of reopening the
closed ID or discarding text.

Queued SDK events retain their source epoch. An old idle marker cannot terminate
a later continuation; new prompts wait until the prior source backlog is
drained. Handoff waits for partial tool arguments, announced backend calls, and
active child lifecycles. The retained mapper preserves ownership across these
boundaries without duplicating tool calls or losing backend results/state.
Unknown explicit child parents and rebinding a native agent identity to another
spawning call (or vice versa) are rejected before child events are emitted.

Continuation state is validated against the state published at handoff.
Unchanged browser state cannot overwrite a later host update; independently
conflicting browser and host updates are rejected before resolving any pending
tool, leaving the original handoff available for a valid retry. Failed parallel
pending RPC resolution cancels and awaits its siblings before native teardown.
Local pending/resolved acknowledgements commit only after the whole batch
succeeds. Explicit cancellation and shutdown join that same RPC settlement and
cleanup path, so a late RPC response cannot mutate a closed context.
Cancelled or completed request-owner tasks are reclaimed on reuse and expiry,
including consumers that abandoned an iterator without calling `aclose()`.

## Native probes and historical observations

These are **real SDK/model probes**, not deterministic test fixtures:

```bash
cd integrations/copilot-sdk/python
uv run python probes/native_continuation.py
uv run python probes/native_continuation.py --parallel
uv run python probes/native_capabilities.py
# With the package-only server running:
uv run python probes/server_roundtrip.py --url http://127.0.0.1:8123
```

They reuse inherited SDK authentication and never inspect/copy credentials or
alter global login. Summaries retain only capability booleans, event types, and
safe fixture exit codes. Nonces and raw responses are not recorded.

Previous local probes observed the behaviors below. Their generated reports are
local-only and are not distributed with this package. These historical results
are not fresh verification of the current SDK pin; rerun the probes after an SDK
update. Deterministic tests do not establish live runtime/model capabilities.

- Single and parallel declaration-only requests, real nonce result consumption,
  original session, one initial send, and reversed parallel resolution.
- Real model-invoked built-in shell: delayed partial output, exit 0, exit 7,
  cooperative abort without a fabricated completion.
- Real subagent lifecycle plus independently scoped child events. The runtime
  rejected explicit **child** model `gpt-4.1`; the recorded isolated probe used
  available `gpt-5.4-mini` for the child. Later native model discovery did not list
  `gpt-4.1`, so the adapter, server, and root probe sessions now default to `auto`.
  Historical successful requests naming `gpt-4.1` do not establish the actual
  model selected by the runtime. Set `COPILOT_MODEL` to an explicitly available
  model when deterministic model selection is required.
- Readable reasoning is model/turn-dependent: emitted on some observed runs,
  absent on others. No reasoning is fabricated to fill a capability gap.
- A recorded `claude-sonnet-5` run produced two distinct invocation `agentId`
  values for the same custom agent name and six attributed child text deltas.
  Its ten readable reasoning events were all root-scoped, with none from the
  children. Replaying that trace preserves this observed source gap rather than
  inventing child reasoning or treating its absence as a mapper failure.
- The independently launched package server passes real native chat, frontend
  nonce continuation with omitted declarations, browser-result-echo suppression,
  and explicit cancellation. Running the probe generates the local-only
  `probes/standalone-server.evidence.json` report; its HTTP client uses only
  Python's standard library.

The native capability probe is not an HTTP feature. Shell is exact-command
allowlisted at both permission and pre-tool boundaries; its isolated child has
no tools. No unrestricted host shell/subagent access is added to the sample.

# ag-ui-claude-agent-sdk

Implementation of the AG-UI protocol for the Anthropic Claude Agent SDK (Python).

## Installation

```bash
pip install -e .
```

## Usage

The adapter manages the SDK lifecycle internally — just call `adapter.run(input_data)`:

```python
from ag_ui_claude_sdk import ClaudeAgentAdapter, add_claude_fastapi_endpoint

adapter = ClaudeAgentAdapter(name="my_agent", options={"model": "claude-haiku-4-5"})
add_claude_fastapi_endpoint(app=app, adapter=adapter, path="/my_agent")
```

## Features

- **Full lifecycle management** - Handles client pooling, message extraction, and event translation internally
- **Interrupt support** - Call `adapter.interrupt()` to stop a running query
- **Dynamic frontend tools** - Client-provided tools automatically added as MCP server with auto-granted permissions
- **Frontend tool halting** - Streams pause after frontend tool calls for client-side execution (human-in-the-loop)
- **Streaming tool arguments** - Real-time TOOL_CALL_ARGS emission as JSON arguments stream in
- **Bidirectional state sync** - Shared state management via ag_ui_update_state tool
- **Context injection** - Context and state injected into prompts for agent awareness
- **Event cleanup** - Hanging events (tool calls, reasoning blocks) automatically closed on stream end
- **Custom tools via MCP** - Define custom tools using Claude SDK's @tool decorator
- **Forwarded props** - Per-run option overrides with security whitelist

## Examples

The integration includes 5 example agents:

| Route                       | Description                    | Features                                         |
| --------------------------- | ------------------------------ | ------------------------------------------------ |
| `/agentic_chat`             | Basic conversational assistant | Simple chat                                      |
| `/backend_tool_rendering`   | Weather tool (backend MCP)     | Backend tool execution, tool rendering           |
| `/shared_state`             | Recipe collaboration           | Bidirectional state sync, ag_ui_update_state     |
| `/human_in_the_loop`        | Task planning with approval    | Frontend tools, step tracking, approval workflow |
| `/tool_based_generative_ui` | Frontend tool rendering        | Dynamic frontend tools, generative UI            |

## Running the Examples

```bash
# Install dependencies
cd integrations/claude-agent-sdk/python
pip install -e .

# Start server (port 8019)
cd examples
ANTHROPIC_API_KEY=sk-ant-xxx python server.py

# Start Dojo (in another terminal)
cd apps/dojo
pnpm dev
```

Visit **http://localhost:3000** and select **"Claude Agent SDK (Python)"**

## Session Persistence

Claude SDK maintains conversation state in the `.claude/` directory. For production deployments:

- **Development**: Sessions persist locally in `.claude/{session_id}/`
- **Production**: Mount `.claude/` as a persistent volume in your container
- **Resumption**: Pass `resume=<session_id>` via the options dict or `forwarded_props`

See [Claude SDK Hosting Guide](https://platform.claude.com/docs/en/agent-sdk/hosting) for deployment patterns.

## Links

- [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/python)
- [AG-UI Documentation](https://docs.ag-ui.com/)
- [AG-UI State Management](https://docs.ag-ui.com/concepts/state)

## Content and state preservation

The adapter emits AG-UI 1.0 content parts for supported tool-result media. It preserves every block in order, including bytes and MIME type; each projected part retains the original SDK block in `metadata.claude.block`. Parts without an AG-UI equivalent retain their JSON payload and an explicit `metadata.claude.unsupportedType`. Tool-result events and final message snapshots use the same projection and error indication. Single plain-text results remain strings, including their original whitespace.

The `claude:assistant_content` custom event retains complete assistant blocks received from the SDK, including reasoning/signatures and richer blocks that the text transcript cannot represent. Its value contains `messageId`, the SDK record `uuid` when available, `parentToolUseId`, and `content`. Streamed message IDs use the native message ID when supplied. Only `mcp__ag_ui__` tool names map to frontend names; external MCP names remain qualified to avoid collisions.

Input uploads remain in `RUN_STARTED.input` with their original metadata. Image and PDF data/URLs are forwarded to Claude; inline UTF-8 `text/plain` documents are decoded from base64, and document `metadata.filename` is forwarded as the document title. Audio/video inputs and unresolved provider file handles emit `claude:unsupported_input` diagnostics and are omitted from the model prompt. Recording those uploads is separate from model comprehension. Native SDK transcripts do not necessarily retain every AG-UI metadata field.

`input.state` is the complete state at the start of a run. The `ag_ui_update_state` tool shallow-merges `state_updates` object keys; nested objects and arrays replace the previous value at that key. The adapter emits the full merged `STATE_SNAPSHOT`, and invalid updates leave the prior state intact. The native state tool result is an acknowledgement, not a saved complete state snapshot. A native transcript with only partial updates cannot establish the missing initial state.

Frontend tool proxies require a result resolver armed for the original tool call by the deferred-tool/session recovery integration. The resolver returns the real frontend result to that call; absent resolution fails explicitly instead of saving a placeholder. Strings retain their bytes; supported structured results become MCP content. This content change must ship with the PNI-659 lifecycle companion. It does not repair historical placeholder results or make arbitrary historical approvals resumable.

Protocol regression tests exercise synthetic SDK streams and proxy callbacks without model calls. They do not establish released support, native persistence across restart, or end-to-end Intelligence replay; those require the lifecycle companion and product validation.

### Session recovery (PNI-659, unreleased)

Frontend tools use in-memory recovery by default: a call pauses with a pending
outcome and its real answer resumes the same session on the same adapter. These
bindings expire with `worker_ttl_seconds`, obey `max_workers`, and are removed by
`clear_session()` or `shutdown()`. No external store is needed for this flow.

For recovery across adapter/process restarts, configure `session_binding_store`, async `resolve_profile(profile)`,
`execution_profile="default"`, and optionally `defer_tools=("Read",)` on
`ClaudeAgentAdapter`. The store implements async `load(thread_id)` returning
`SessionBinding(session_id, profile, pending=None)` and async `save(thread_id,
binding)`. Save must commit durably before returning. The trusted profile resolver
returns SDK options with the original working directory, tools, native
`session_store` if applicable, permission configuration and credentials.
Credentials and callbacks belong in the host configuration, not the binding.
Without this configuration backend-restart recovery is unavailable.

Imported thread IDs must resolve to the original native UUID/profile through the
host store. Return `None` only for genuinely new threads; throw for a missing
imported record. A pending binding must come from the SDK's saved deferral,
`{ "id": original_call_id, "name": native_tool_name, "input": original_input }`.
An unfinished historical tool call or a dead permission callback is insufficient.
PNI-657 owns import extraction/routing. Apply tenant authorization and an
application lock across workers/replicas, and reconcile against native storage
after a crashed save or out-of-band SDK activity.

Native approvals emit the AG-UI interrupt outcome. Answer through
`resume=[{"interruptId": original_call_id, "status": "resolved", "payload":
{"behavior": "allow" or "deny"}}]`. Optional `message` and `updatedInput` follow
the SDK hook contract; cancelled responses deny the call. Existing host hooks
still apply; avoid a second unconditional deferral hook for the same call.
The adapter restores the original session with `fork_session=False` and uses
`--await-initialize` so callback registration precedes automatic saved-tool replay.
It receives that replay without sending an empty user message. Tested versions:
Python SDK **0.2.166**, bundled CLI **2.1.299**, AG-UI **1.0**. Use the bundled CLI;
custom binaries older than 2.1.261 lack the startup barrier. Local transcript
lookup needs matching host/query `CLAUDE_CONFIG_DIR` settings.

Frontend deferrals under `mcp__ag_ui__` use an authenticated loopback HTTP
MCP endpoint, connected with `alwaysLoad` before native replay. The endpoint
exists only for the query and closes afterward. The binding also stores the
original frontend tool declarations (`frontendTools` in TypeScript,
`frontend_tools` in Python); persist these fields unchanged so a delta-only
`ToolMessage` with `tools: []` can resume the original call after restart.
Tool errors retain their native failure flag. Other host-provided in-process SDK
MCP deferrals remain guarded because those servers register too late for replay.
Durable deferral supports **one tool call at a time**, not parallel calls.

`PYTHONPATH=. python scripts/probe_durable_resume.py` uses a localhost fake
provider and disposable synthetic native files. It constructs a new adapter for
each resumed run, checks allow and deny independently, and compares native saved
results with AG-UI emissions by original call ID. Unit tests additionally cover
identity mismatches, unmatched callbacks and pending-state restoration. These
checks do not validate remote storage, production credentials, Intelligence/UI
replay or the six-row product matrix. Release and final validation remain pending.

The frontend probe (`scripts/probe-frontend-resume.mjs`, with optional `--error`,
in TypeScript; `scripts/probe_frontend_resume.py` in Python) additionally checks
original-session frontend results with omitted tool definitions, native saved
results, and a fresh SDK history read. It uses the same isolated fake-provider
setup as the native approval probe.

Use `--memory` with the Python frontend probe to exercise the default adapter
without an external store. Use `--full-history` in either port to submit the full
conversation instead of only the answer. Both modes verify one snapshot result
per call, its stable submitted message ID, and native content/error projection.

#### Unsupported pending batches

Once multiple deferrals are observed, the adapter persists their diagnostic
metadata before acknowledging the hook. Concurrent hook writes are serialized.
If calls remain unresolved, a stream exception or cancellation before the terminal
SDK result leaves the acknowledged batch blocked when a fresh adapter loads the binding.

When all observed calls complete, accepting the last matching native result clears
and persists the obsolete batch diagnostic before processing later stream events.
This also applies when a child result arrives after the deferred parent results:
previously, a later SDK error or transport exception could leave the completed
batch blocked across adapter restarts. A child result must match both its tool ID
and `parent_tool_use_id`; any unresolved sibling keeps the diagnostic in place.

Adapter regressions cover child-first and child-last completion with successful,
SDK-error and transport-exception endings, using a JSON-serializing binding store
and mocked SDK workers. They verify a new user turn through a fresh adapter and do
not call a hosted model or repair already-stale persisted bindings.

If several calls are deferred before a result is available, the adapter saves
all observed original IDs, names and arguments in
`SessionBinding.unsupported_pending_tools`, retains the SDK's `pending` call,
and emits `RUN_ERROR`. Persist this optional field in custom binding stores.
A new adapter/process refuses to resume that binding. For older singleton
bindings, the adapter reads native history before continuation and retains
unresolved siblings when the saved call is among them. Completed native
results, including empty results, are excluded from that diagnostic. Failed
history reads fail the run rather than skipping the check.

This is failure containment, not batch recovery: no sibling results are
fabricated, no native transcript is rewritten, and no submitted answer or next
user message is sent to the SDK on rejection. The caller must retain rejected
input. Do not clear the diagnostic field or replay each sibling independently
to bypass the guard. Existing batches require upstream SDK recovery support;
missing historical calls or results cannot be reconstructed by this adapter.
See the SDK's [single-call deferral limitation](https://code.claude.com/docs/en/hooks#defer-a-tool-call-for-later).

No provider configuration is changed automatically. A trusted deployment may
configure sequential generation for future turns, but must verify the actual
provider request and respect organization policy. Such prevention does not
repair existing batches. Single-call continuation still requires the original
session, tool configuration, result ownership and approval checks.

#### Unresolved child calls (default behavior)

Parent completion, an Agent launch result, and task completion notifications do
not resolve a child's tool call. The adapter tracks observed child tool uses
until a native result matches both the tool ID and `parent_tool_use_id`. At
parent completion, unresolved calls are retained in `unsupported_pending_tools`
with their original ID, name, input and `parentToolUseId`; the run emits
`RUN_ERROR`. Persist this field unchanged. Cold continuation is rejected before
starting the SDK, even when only one child call is unresolved. Child identities
are never exposed as actionable parent-session approvals.

The SDK documents [subagent continuation](https://code.claude.com/docs/en/agent-sdk/subagents#resume-subagents)
through a new prompt naming the agent, but this is not a verified exact-call
deferral replay contract. The default recovery mode therefore does not attempt child
recovery or modify transcripts. The opt-in local mode below provides a separately
validated recovery path. Already-lost diagnostics
in older bindings cannot be reconstructed from parent completion alone.

#### Opt-in native child recovery without Intelligence

Native child recovery reconstructs unanswered approval requests from the SDK's
local session files. It does not read Intelligence events, require an AG-UI event
store, or persist a separate question/answer database. Keep the original native
session UUID and pass it as `forwardedProps.resume` after restarting the server.
A refresh without an answer returns the same `RUN_FINISHED` interrupt without
starting the SDK or making a model request. Answer with `resume` containing the
original `interruptId`, `status: "resolved"`, and `payload: { behavior: "allow" }`
(or `"deny"`). Cancellation is also treated as denial.

This mode requires a local POSIX runtime and bundled CLI **2.1.306**. It
reconstructs parallel root and child calls, including nested and background
children linked through native `.meta.json` files. Ambiguous identities,
remote/SessionStore, forked, and rewound sessions fail closed. Default single-call
`defer` recovery and its safeguards remain unchanged.

Provide current frontend tool declarations in `input.tools`. Frontend interrupts
use `reason: "tool_call"`; native approvals use `reason: "tool_approval"`.
Answer frontend calls with original-ID `role: "tool"` messages containing the
actual result. The public interrupt hook also supplies a `resume` entry for that
same ID: its payload must equal the raw string result (including an empty string) or
the parsed JSON tool result (cancellation uses
`{"status":"cancelled"}` and saves an error result). The message remains the
source of the result; a frontend resume entry alone cannot supply it.
When a registered frontend handler already added its result, reuse that exact
message and put its content in the matching resume payload. Do not append a
second tool result or replace empty content with a display acknowledgement.
Automatic handler/interrupt reconciliation is a client responsibility; explicit
full resume works without modifying pending interrupts or native history.

Native approvals use `resume`. After a downstream error, retrying the approval
alongside an already-streamed matching native result reuses the canonical saved
result without executing again. A client-supplied result cannot answer a native
call that has no saved result. Conflicting results fail before execution.

The adapter supports partial submissions and persists each answer immediately.
The public AG-UI client requires a resume entry for every pending interrupt,
so collect all answers before submitting through that client. Imported child
calls may exist only in child history: render their interrupt metadata and
answer the original ID without fabricating a root assistant tool call.

The built-in `mcp__ag_ui__ag_ui_update_state` tool is automatic, not a user
approval. If shutdown interrupted its acknowledgement, the adapter invokes its
actual internal handler and saves that acknowledgement before continuing. It
never asks the host executor or user to answer this internal call. Supply the
complete initial `input.state`: an acknowledgement does not reconstruct missing
initial state from partial updates.

The trusted host configuration supplies:

- `directory`: the original `CLAUDE_CONFIG_DIR/projects` directory.
- `tools`: the explicit native root or child tool names requiring approval.
- `execute(call, key)`: execute the original name/input under the host's normal
  authorization rules, returning the **actual** string `content` and optional
  boolean `is_error`. An approval is not a tool result. The callback must be
  idempotent across process crashes using the supplied session/child/call key;
  the adapter cannot make arbitrary external side effects transactional.
- `acquire(sessionId)`: acquire exclusive ownership of the native session across
  all writers and return an async release callback. A standalone CLI can use a
  process-owned OS file lock. A service can use its existing session lease.
  The lease must survive the whole recovery operation; never substitute a no-op
  when concurrent writers are possible. This is execution ownership, not event
  or approval storage.

On approval, the adapter records the real result under the original call ID.
For an unfinished child, it resumes that same child with `SendMessage`, denies unrelated parent tools,
and holds the parent's `PostToolUse` hook. Recovery-worker parent output is not
forwarded to the UI. Once the child's final result is present in native storage,
it terminates the isolated worker process group **before** releasing the hook,
repairs the original parent result while no SDK writer is running, and resumes
fresh. Actual child and parent tool results are emitted as AG-UI events. A child
that asks another question returns another interrupt. A timeout/failure leaves
the parent unresolved rather than treating the child as complete. If the host
crashes after child completion but before the recovery SendMessage result is
saved, a restart returns RUN_ERROR and leaves the parent unresolved. Child
completion alone cannot reconstruct that lost tool result.

This is a version-sensitive native-history workaround, not a supported SDK
checkpoint API. Normal SDK shutdown can release the held hook and allow a parent
request before repair; the recovery worker therefore uses immediate process-group
termination. Normal completed runs retain graceful shutdown. Children recover
from leaves outward before parent continuation. Background completion is appended
as an actual completion message; the original successful launch result remains
unchanged. Diagnostic `api-request-blob` copies are preserved and never treated
as canonical calls or results. Ambiguous child identities remain unsupported.

Pass `native_child_recovery=NativeChildRecoveryConfig(directory, tools, execute,
acquire, timeout_seconds=10)` to `ClaudeAgentAdapter`. The timeout must be below
50 seconds. This mode uses a version-pinned isolated subprocess transport;
`claude-agent-sdk==0.2.170` is required.

The standalone regression harness uses separate host processes, a localhost
synthetic provider, and disposable native files. No paid inference or Intelligence
service is used. Run from the repository root after installing integration deps:

```sh
python integrations/claude-agent-sdk/scripts/test_child_recovery.py ts allow
python integrations/claude-agent-sdk/scripts/test_child_recovery.py ts deny
python integrations/claude-agent-sdk/scripts/test_child_recovery.py ts allow --stall
# Use the Python integration's .venv/bin/python and replace ts with py for Python.
```

### Interrupted recovery delivery retries

An interrupted internal recovery `SendMessage` retains its original unknown
error result. If native history contains a later successful delivery receipt
for the same child and exact recovery message, both issued under the adapter's
exact recovery prompt, the earlier control is superseded for pending-call
accounting. Its result is neither replaced nor relabeled as success. Parent
repair still requires the child's actual completed native response. Missing or
failed receipts, other targets/messages, arbitrary SendMessage calls and absent
interrupted result blocks remain fail-closed.

An isolated copy of the original failed nested Python session was continued
through the real SDK against a local scripted provider, then continued in a
second fresh process. Both reached parent completion; no native tools executed
again, and the original unknown bridge result remained unchanged. The fixture
comparator accepted only the exact SDK environment reminder with `/var` and
`/private/var` paths resolving to the same recorded directory. The failed attempt
and its ledger/history were retained. The coordinator's original browser session
still requires retry after deploying this change.

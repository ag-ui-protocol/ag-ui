# Native recovery validation — 2026-10-23

The opt-in `nativeChildRecovery` / `native_child_recovery` path uses native SDK
files and a trusted host executor/lease. It does not require Intelligence, AG-UI
saved events, or a separate approval database. Default single-call deferral
behavior is unchanged.

## Versions and checks

- TypeScript Agent SDK **0.3.306**, Python Agent SDK **0.2.170**, bundled CLI
  **2.1.306**. Other native history versions are rejected.
- TS peers: Anthropic SDK 0.113.0, MCP 1.29.0, Zod 3.25.76 workspace override.
- Python 3.14.4 and the integration's existing frozen-lock environment.
- TypeScript unit tests, typecheck and CJS/ESM/declaration builds; Python full
  integration suite; `git diff --check`.

Validation used the installed dependencies from the original child-recovery
worktree, linked into this follow-up worktree. It was not a fresh dependency
installation. The pinned native SDK versions above were unchanged.

## Real SDK controls with a local provider

The scripts below launch actual SDK subprocesses with disposable native files,
synthetic credentials and a scripted localhost Messages provider. Each phase
uses a fresh adapter host. Actual provider requests and AG-UI events are retained
in the printed `evidence.json`; snapshots preserve native JSONL and child sidecars
before/after partial answers, completion, retransmission and another restart.
There are no paid inference calls. These tests verify scheduling, persistence,
original identities and model-facing content, not live-model reasoning.

Both languages passed:

| Control | Assertions |
| --- | --- |
| Two root calls | Both questions survive refresh; partial answers leave only the other question; actual results reach the model; executor does not rerun |
| Native + frontend + state | Frontend result keeps the original ID; state update reaches AG-UI; internal state acknowledgement never becomes a user approval |
| Root denial with replayed UI history | Denial remains an error, does not execute, survives full message retransmission and another restart |
| Two children | Both native questions survive refresh and partial answers; recovery finishes children before the parent |
| Nested child | Leaf result repairs the owning child's Agent call with sidechain ancestry, then recovery proceeds outward |
| Background children | Original successful launch results remain intact; actual child completion is appended before parent continuation |
| Mixed root/native child/frontend child | Root and child questions coexist; partial completion stays completed; allow/deny results reach original calls |
| Follow-up frontend question | A recovering child asks again; its AG-UI tool call is emitted, returns an interrupt, survives refresh, accepts its result and finishes |
| Imported SDK defer | An original session created with a real SDK defer is answered through native recovery and survives retransmission and another restart |

The original single-child allow/deny/stalled-child controls remain available.
They verify that deliberately attempted parent Write calls are denied during
recovery and that a stalled child never permits parent continuation. Those six
controls passed for PR3151; the expanded controls above validate this follow-up.

Copies of earlier real paused histories with an unfinished internal state call
were also refreshed through both adapters with no reachable provider. They
received the actual internal acknowledgement and returned only the two user
questions; no native executor ran. Original evidence remained unchanged.

## Fixes exercised by these controls

Only canonical assistant/user rows define tool calls/results. Diagnostic copies
such as `api-request-blob` remain unchanged. `.meta.json.toolUseId` identifies the
owning Agent call; `parentAgentId`, when present, must agree with that owner.

Recovery waits for every pending answer and then walks children from leaves to
parents. The parent bridge permits only the intended SendMessage, holds the
parent after that call, and stops its isolated process group before releasing
that hook. Child output is emitted normally; bridge-parent output is suppressed.
Each TypeScript worker gets its own authenticated loopback MCP connection, so
frontend tools remain available through multiple recovery workers.

A resolved SDK `hook_deferred_tool` attachment must no longer be executable:
Python otherwise replays it despite the actual saved result. After answering,
the adapter moves that exact marker into `agUiResolvedDeferrals` on the actual
result and reconnects its immediate descendants' native ancestry. Unanswered
markers and diagnostic records remain unchanged.

Unit regressions cover diagnostic duplicates, nested sidechain ancestry,
conflicting parent metadata, validation before handlers, automatic acknowledgements
only once, conflicting result/error retransmissions, and retirement/provenance of
resolved deferrals. Cold-start completed-child fixtures still reject an unresolved
recovery SendMessage; child completion cannot invent its lost result.

## Host contract and remaining limits

The host must provide an exclusive lease covering all native-session writers and
an authorized executor idempotent by `sessionId:childId:toolCallId` (empty child ID
for root). The fixture supervisor serializes workers and uses a no-op lease;
production distributed locks and external side effects across process death are
not certified by these tests.

This is version-sensitive native-history editing on local POSIX storage, not a
supported SDK checkpoint API. Remote/custom SessionStore, fork/rewind, Windows,
ambiguous native ownership and unconfigured pending tools fail explicitly. The
bridge still needs a model request to select SendMessage; an incorrect response
fails by timeout. A crash that loses an actual bridge result remains fail-closed.

Frontend recovery is verified here with text/JSON string results and error flags.
Rich media rendering, A2UI/chart behavior in an actual browser, consumer import and
repeat-import persistence, published-package wiring, and the combined Intelligence
service lifecycle require consumer validation. These controls do not establish
full product parity. The importer must distinguish automatic internal state
acknowledgements from user-facing approvals and retain completed siblings.

## Reproduce

From the repository root with dependencies installed:

```sh
NX_DAEMON=false pnpm exec nx run-many -t test,typecheck,build \
  --projects=@ag-ui/claude-agent-sdk --excludeTaskDependencies --parallel=1
```

Use the Python integration environment for the subprocess harnesses:

```sh
python integrations/claude-agent-sdk/scripts/test_parallel_recovery.py ts --frontend --state
python integrations/claude-agent-sdk/scripts/test_parallel_recovery.py ts --deny --history
python integrations/claude-agent-sdk/scripts/test_dependency_recovery.py ts --nested
python integrations/claude-agent-sdk/scripts/test_dependency_recovery.py ts --background
python integrations/claude-agent-sdk/scripts/test_dependency_recovery.py ts --mixed --frontend --deny
python integrations/claude-agent-sdk/scripts/test_dependency_recovery.py ts --frontend --followup
python integrations/claude-agent-sdk/scripts/test_imported_recovery.py ts
```

Repeat with `py`. Run `uv run --frozen pytest tests -q` from the Python integration
for its unit suite. The standalone single-child controls use
`test_child_recovery.py ts allow`, `ts deny`, and `ts allow --stall` (and `py`).

## Public-client recovery contract

`test_dependency_recovery.py ts --mixed --frontend --public-client` (also `py`)
uses a real HttpAgent over loopback HTTP, fresh adapter/SDK processes per request,
and a synthetic local provider. It imports root history without inventing child
assistant calls, submits the full public resume array plus the actual frontend
result, then retries and continues after another restart. The harness verifies
all original IDs, frontend interrupt classification, exact tool catalog/context
forwarding, and one execution per native call. Partial public-client submissions
must fail before reaching the host. Optional `--cpk-core /absolute/package/path`
exercises installed CopilotKitCore.runAgent; `--cancel-frontend` checks cancellation.

The standard-resume unit tests additionally simulate a downstream timeout after
answers are persisted and emitted, then retry the old approvals with those saved
results. Canonical results remain unchanged and the executor runs only once.
These controls do not verify React rendering or recovery of the coordinator's
specific timed-out nested session; that original-session browser retry remains
consumer validation.

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

### Saved result delivery after executor failure

Both adapters replay configured tool results from native history when absent
from the submitted client messages. This covers A succeeding and being saved,
then sibling B throwing before the checkpoint emits its results. A cold retry
emits both original results without executing A again, even if the retry only
answers B. Once the client includes the matching tool messages, no replay is
needed. Regressions check original IDs, actual content, executor counts and
acknowledged-history retries through the AG-UI event translator.

### Registered frontend handler outcomes

Raw frontend strings, including empty strings and JSON-looking strings, match
an identical resume payload without changing the original result bytes. The
hook's JSON payload encoding also remains supported. Conflicting payloads fail
before native execution; duplicate tool messages remain rejected.

No-cost registered-handler controls for TS and Python use actual CopilotKitCore,
HttpAgent, and fresh real SDK workers behind a localhost synthetic provider:

```sh
python integrations/claude-agent-sdk/scripts/test_parallel_recovery.py ts --registered-root --cpk-core /absolute/path/to/@copilotkit/core
python integrations/claude-agent-sdk/scripts/test_dependency_recovery.py ts --mixed --frontend --public-client --raw-frontend
```

Repeat with `py`. The root control registers a real handler returning an empty
string, verifies two parallel root tool_call interrupts, reuses both actual
messages for explicit full resume, retries, and continues after another restart.
It checks handler executions, original message IDs/content, catalog/context and
zero native executor calls. It sets `followUp: false` so it can submit the full
resume explicitly; this does NOT certify automatic CopilotKit reconciliation.
The mixed control covers root/native child approvals plus a raw child frontend
result with the real public client and further fresh workers.

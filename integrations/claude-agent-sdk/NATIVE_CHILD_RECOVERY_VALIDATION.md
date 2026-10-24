# Native child recovery validation — 2026-10-22

Implemented as opt-in `nativeChildRecovery` (TypeScript) / `native_child_recovery`
(Python). Default SDK single-call deferral and unsupported-batch guards remain
unchanged. No Intelligence code, event database, or separate approval store is
used by this recovery path.

## Verified versions and checks

- TypeScript Agent SDK 0.3.306, bundled CLI 2.1.306. Validation also used the
  repository's locked peer versions: Anthropic SDK 0.113.0, MCP 1.29.0, Zod
  3.25.76 (workspace override).
- Python Agent SDK 0.2.170, bundled CLI 2.1.306, Python 3.14.4. Full suite and
  final subprocess controls use the committed uv lockfile.
- TypeScript: 111 tests pass; typecheck and CJS/ESM/declaration builds pass.
- Python: 211 tests pass (two existing WebSockets deprecation warnings).
- `git diff --check` passes.

The tests use real SDK subprocesses with a local scripted Messages provider,
synthetic credentials and disposable native files. They exercise SDK scheduling,
hooks, native storage, adapter reconstruction and AG-UI events. They do not test
live-model reasoning or a production deployment. Any SDK cost estimate comes
from fixture token counts; there are no paid inference calls.

## Standalone process controls

`./scripts/test_child_recovery.py` runs separate adapter host processes for:

1. Parent starts one foreground child. Child requests Read. The integration
   waits for its unanswered native call to be saved, stops the isolated SDK
   worker and returns an interrupt. Nothing has answered or executed Read.
2. Two subsequent fresh host processes receive only the session UUID, with no
   saved AG-UI messages or events. Both reconstruct the same question. Neither
   starts a model request or executes the tool.
3. Another fresh process receives allow or deny against the original call ID.
   Allow runs a restricted fixture executor once; deny never runs it. The actual
   result is stored under that original child call ID.
4. Recovery permits only SendMessage to the original child, blocks a deliberately
   requested parent Write, and holds the parent after that call. The child's
   provider request contains the actual result. The child finishes while the
   parent remains held.
5. Once child completion is saved, the isolated worker is killed before its hook
   is released. The adapter records observed recovery-tool outcomes, repairs the
   original parent Agent result and starts a fresh SDK worker. The parent request
   contains that repaired result. A further host restart sees it again.

| Language   | Decision/control          | Model requests | Executor calls | Parent Write   |
| ---------- | ------------------------- | -------------: | -------------: | -------------- |
| TypeScript | Allow                     |              6 |              1 | Never executed |
| TypeScript | Deny                      |              6 |              0 | Never executed |
| TypeScript | Stalled child after allow |              4 |              1 | Never executed |
| Python     | Allow                     |              6 |              1 | Never executed |
| Python     | Deny                      |              6 |              0 | Never executed |
| Python     | Stalled child after allow |              4 |              1 | Never executed |

Successful answer runs emit AG-UI results for both the original child tool and
original parent Agent call, with actual content. A denied leaf remains an error;
the parent receives the child's completed report. Stalled-child controls emit
RUN_ERROR and never continue the parent. No synthetic successful result is used
to cover an incomplete child. Normal completed SDK turns close gracefully;
held recovery workers are terminated before SDK shutdown can unblock the parent.

## Review regressions

Both implementations now reject parent repair if any other root tool result is
still unresolved. Synthetic cold-start fixtures cover a completed child with a
missing recovery SendMessage result and with an interrupted placeholder. They
assert no SDK startup, no executor call, lease release, and unchanged parent
history. A known actual bridge response can still be settled and repaired.

Hook-level fixtures also attempt foreground and background nested Agent launches
during recovery; both are denied. These boundary regressions use synthetic
history and mocked SDK hooks, not real process crashes or live model reasoning.
The six standalone real-SDK process controls above were rerun after these fixes
and passed.

## Required host contracts and limits

The host must supply an exclusive session lease and an executor that preserves
normal tool authorization and is idempotent by the supplied session/child/call
key. The test supervisor serializes workers, so its lease is a no-op; this is
not sufficient for a service with concurrent native-session writers. Arbitrary
side effects and transcript writes cannot be made atomic by this adapter.

The verified path is one direct foreground child, native string tool results,
local POSIX storage and the pinned CLI. Native-history editing and Python's
isolated transport are version-sensitive. Other history versions, remote
SessionStore, custom TypeScript transports, fork/rewind, multiple child files,
unknown pending tool executors, and frontend MCP tools in this mode fail closed.
New background or nested Agent launches are denied in this mode. Root batch
recovery is unchanged and unsupported. Parallel child approval execution and
additional nested/branching layouts are not certified by these tests.

The bridge still needs one parent model request to request SendMessage. Its
output is suppressed and unrelated tool execution is denied. A model that does
not select the required recovery call fails by timeout; no reasoning-based
promise substitutes for the gate. Production distributed lease behavior,
host death during external tool side effects, power-loss durability, and Windows
are not claimed by this validation.

## Reproduce

From the repository root, with dependencies installed:

```sh
NX_DAEMON=false pnpm exec nx run-many -t test,typecheck,build \
  --projects=@ag-ui/claude-agent-sdk --excludeTaskDependencies --parallel=1
cd integrations/claude-agent-sdk/python
uv sync --frozen --group dev
uv run --frozen pytest tests -q
```

Run `python integrations/claude-agent-sdk/scripts/test_child_recovery.py ts allow`
from the root, then `ts deny`, `ts allow --stall`, and the equivalent three `py`
cases. Use the Python integration's `.venv/bin/python` for the Python controls.
Each run prints an evidence path containing actual provider requests and AG-UI
output, and retains per-process logs in the same disposable directory.

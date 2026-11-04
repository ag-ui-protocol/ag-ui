# PNI-659 recovery evidence — 2026-10-15

Status: ready for code review; not released, not full product validation.
Companion content implementation: [AG-UI #3058](https://github.com/ag-ui-protocol/ag-ui/pull/3058).
Import/routing/projection companion: [Intelligence #1879](https://github.com/CopilotKit/Intelligence/pull/1879).

## Baseline and tests

- TypeScript Agent SDK 0.3.296 / bundled CLI 2.1.296; AG-UI core/client 1.0.0 in the isolated validation environment. Typecheck and 66 focused tests pass.
- Python Agent SDK 0.2.166 / bundled CLI 2.1.299; AG-UI protocol 1.0.0, Python 3.14.4. 166 focused tests pass.
- Tests use actual published SDK packages, not editable SDK overrides. The adapters are this branch's source plus the explicit PNI-658 companion.
- Review verification ran the focused TypeScript tests and typecheck through Nx with prerequisite tasks excluded; Python used the frozen-environment pytest suite. Earlier full workspace prerequisite builds were unavailable locally. No full workspace or product-stack pass is claimed.

## Actual SDK subprocess controls

The checked-in [TypeScript probe](typescript/scripts/probe-durable-resume.mjs)
and [Python probe](python/scripts/probe_durable_resume.py) use a localhost fake
Anthropic Messages endpoint and generated synthetic files. There are no external
model requests or personal histories. Each control creates one SDK session,
saves a native `Read` deferral, destroys the adapter, constructs another adapter
with the same binding store/profile, and answers the original call.

Allow and deny independently preserve the SDK UUID and tool-use ID. Allow saves
the actual synthetic file text. Deny saves the real native error result and does
not execute Read. The emitted AG-UI tool result agrees with native storage;
denials use the adapter's explicit JSON error envelope and retain `is_error` in
`rawEvent`. Each case uses exactly two model requests: initial tool selection and
one resumed completion, without a synthetic empty-user follow-up.

The controls use local JSONL storage. They demonstrate adapter reconstruction
and separate SDK subprocesses; the binding-store test double remains in the test
host. A production database store, host restart, distributed locking, custom
SessionStore backend, remote storage, credentials, browser/Intelligence replay,
and the six-row product matrix are not certified by this evidence.

## Startup findings and frontend recovery

Without `--await-initialize`, automatic native deferred replay can occur before
SDK hooks register. A requested deny can be skipped. The adapter therefore sets
that barrier for original-session resume. It requires the tested bundled CLI
(or another verified compatible binary); the flag was added in CLI 2.1.261.
Sending an empty string adds a user/model turn; TypeScript instead keeps an
empty input stream open through the result, and Python receives the automatic
replay without calling `client.query` again.

The [MCP limitation probe](typescript/scripts/probe-mcp-deferral-limit.mjs)
reproduces a startup limitation in in-process SDK MCP servers: native replay
checks tool availability before these servers register. The adapter now serves
its frontend proxy over authenticated loopback HTTP with `alwaysLoad`, so the
CLI connects before replay. Each endpoint uses a random bearer token and checks
its Host/path; it closes when the query ends. Other host-provided in-process SDK
MCP pending calls are still guarded.

The new [TypeScript frontend probe](typescript/scripts/probe-frontend-resume.mjs)
and [Python frontend probe](python/scripts/probe_frontend_resume.py) exercise
actual SDK subprocesses with new adapter instances. Resumed requests contain only
the answer and `tools: []`; tool declarations are restored from the host binding.
Success and error results persist exactly once under the original session/call.
The fresh native SDK history reader returns the same saved result. AG-UI output
agrees with the native result (singleton text normalizes to a string; errors use
the documented error envelope). Each case makes two model calls, without an
extra synthetic user turn. Python additionally checks a declined frontend answer
as a successful result payload, separate from a tool execution error.

Python validation uses the frozen lock (MCP 1.25.0 and Uvicorn 0.40.0); TS uses
locked MCP 1.29.0 in the isolated test environment. Python SDK handlers require
`is_error` while TypeScript handlers require `isError`; the companion helper
includes a real MCP boundary regression for that distinction.

The SDK's durable deferral supports one tool call at a time. Parallel-call
approval recovery is not implemented or promised. Historical callbacks without
a saved `hook_deferred_tool` marker remain unrecoverable.

## Follow-up

Validate Intelligence's consumer projection and browser compatibility separately.
Release and final six-row validation remain with the authorized release/user
workflow. No Linear Done or matrix update is justified by this draft.

## Review regressions — 2026-10-15

- Python default frontend tools now use bounded in-memory recovery; external
  storage remains optional for cross-process durability. The `--memory` probe
  pauses after exactly one model call and accepts the answer on the same adapter.
- Dict and `ClaudeAgentOptions` profiles merge before the current state/context
  prompt and generated tool permissions are derived.
- TypeScript clear, TTL, and capacity eviction remove their in-memory bindings.
  Active sessions are excluded from eviction; durable host stores remain host-owned.
- Both adapters reconcile SDK result echoes by original call ID and retain the
  submitted message ID, using the native content/error projection in the snapshot.
- Actual frontend probes pass for both delta-only input and `--full-history`,
  success and error, including Python default memory and configured durable stores.
  Each case retains one native result and one snapshot result and makes exactly two
  model requests. These checks do not extend the product validation scope above.

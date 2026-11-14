# Changelog

## 0.2.0 (unreleased)

Breaking AG-UI 1.0 update: depends on core 0.2.0, adds explicit `run_input`,
complete reconciled history, typed activity/reasoning/subagent callbacks,
outcome, usage, resume entries, and structured diagnostics. Rust 1.88 is required.

Migration notes:
- `AgentConfig`, `RunAgentParams`, `RunAgentResult`, `SseLimits` and
  `ErrorBodyLimits` are non-exhaustive. Use defaults/builders or their `new`
  constructors, then assign public fields. `RunAgentResult::new` requires a
  terminal status and final state; it starts with empty history and no optional
  result/outcome/usage. Include a wildcard arm for `RunTerminalStatus` matches.
- Public protocol enums and record structs are non-exhaustive. Add wildcard
  branches to matches and construct protocol records with `new(...)` or `Default`,
  then set optional public fields; external struct literals no longer compile.
- Carry complete `messages` and `new_state` into subsequent turns; `new_messages`
  alone cannot reproduce replacements and removals.
- Chunk events expand to start/content/end events. The three chunk subscriber
  hooks were removed because they never fired; migrate to the expanded event hooks.
  Existing overrides now fail at compile time rather than silently losing behavior.
  Replace `on_text_message_chunk_event` with `on_text_message_start_event`,
  `on_text_message_content_event`, and `on_text_message_end_event`;
  replace `on_tool_call_chunk_event` with `on_tool_call_start_event`,
  `on_tool_call_args_event`, and `on_tool_call_end_event`; replace
  `on_reasoning_message_chunk_event` with the reasoning start/content/end hooks.
- Deprecated `THINKING_*` events translate to reasoning events with diagnostics.
- IDs compare byte-for-byte and `ToolCallId::random()` generates a hyphenated
  UUID without a `call_` prefix (`random_call()` retains the prefixed form).
  Empty text deltas are valid. Treat identifiers as opaque.
- `with_timeout` is a deadline for the entire streamed run. A timeout is not
  automatically safe to retry after the producer has begun work.
- Finalizers run for ordinary result failures; cancellation and callback panics
  cannot await asynchronous finalizers.
- Non-success HTTP response bodies are captured with byte/time bounds by default.
  Normal Display/Debug output omits payloads; use `http_error_body()` to inspect
  them explicitly. Set the byte limit to zero to disable capture.
- `RunAgentResult.result` is now `Option<Value>` and the redundant `output` field
  is removed. Result is present only for success (including omitted outcome);
  missing/whole-null results and cancelled/interrupted outcomes become `None`.
  Nested null values remain intact.
- Unknown present text roles fail like canonical Python/TypeScript instead of
  being stripped. Run/thread ID mismatches are accepted like TypeScript; normal
  lifecycle ordering and terminal completion are still required.

Crates have not been published. Git delivery uses a qualified upstream commit;
CI verifies workspace packaging separately from publication.

### Constructing extensible configuration

```rust
use ag_ui_client::{agent::AgentConfig, sse::SseLimits};
let mut config = AgentConfig::<serde_json::Value>::default();
config.debug = Some(true); // replaces AgentConfig { debug: Some(true), ..Default::default() }
let limits = SseLimits::new(1024, 4096); // replaces the two-field struct literal
```

Use `RunAgentParams::new()` / `new_typed()` and its builders instead of a
`RunAgentParams` literal. `ErrorBodyLimits::new(bytes, timeout)` sets explicit
capture bounds. Construct synthetic results with `RunAgentResult::new(status,
state)`, then set history and optional output fields. Non-exhaustive enum matches
must have a fallback, for example `other => log::warn!("unknown status: {other:?}")`.

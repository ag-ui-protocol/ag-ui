# Changelog

## 0.2.0 (unreleased)

Breaking AG-UI 1.0 update: depends on core 0.2.0, adds explicit `run_input`,
complete reconciled history, typed activity/reasoning/subagent callbacks,
outcome, usage, resume entries, and structured diagnostics. Rust 1.88 is required.

Migration notes:
- Public protocol enums are non-exhaustive; add wildcard branches to external
  matches. Public structs retain literal construction, so future field additions
  may still require breaking releases.
- Carry complete `messages` and `new_state` into subsequent turns; `new_messages`
  alone cannot reproduce replacements and removals.
- Chunk events expand to start/content/end events. The three chunk subscriber
  hooks are deprecated and do not fire; migrate to the expanded event hooks.
- Deprecated `THINKING_*` events translate to reasoning events with diagnostics.
- IDs compare byte-for-byte and `ToolCallId::random()` generates a hyphenated
  UUID without a `call_` prefix (`random_call()` retains the prefixed form).
  Empty text deltas are valid. Treat identifiers as opaque.
- `with_timeout` is a deadline for the entire streamed run. A timeout is not
  automatically safe to retry after the producer has begun work.
- Finalizers run for ordinary result failures; cancellation and callback panics
  cannot await asynchronous finalizers.
- Non-success HTTP response bodies remain redacted by default.

Crates have not been published. Git delivery uses a qualified upstream commit;
CI verifies workspace packaging separately from publication.

# Changelog

## 0.2.0 (unreleased)

Breaking AG-UI 1.0 update: string identifiers, seven message roles, multimodal
content, activity/reasoning/subagent events, typed JSON Patch, run outcomes,
usage, interrupts, resume entries, and capabilities. Rust 1.88 is required.

Migration notes:
- Public protocol enums and record structs are non-exhaustive. Add wildcard
  branches to external enum matches and `..` to struct patterns. Replace struct
  literals with required-field constructors or `Default` for all-optional
  records, then assign optional fields. Events support `with_base` metadata.
- IDs are compared byte-for-byte. Do not rely on UUID normalization or parsing.
- `ToolCallId::random()` now generates a hyphenated UUID string without a
  `call_` prefix. `random_call()` supplies the prefixed form when needed;
  otherwise treat IDs as opaque.
- Empty text deltas are accepted. Applications should not use nonempty content
  as a condition for advancing the event lifecycle.
- Use explicit processing boundaries for wire validation; bare serde parsing
  only checks typed representation.
- Deprecated thinking events and binary content are translated at the
  compatibility boundary with diagnostics.
- State patches are applied atomically with bounded nesting.

Crates have not been published. Git delivery uses a qualified upstream commit;
CI verifies workspace packaging separately from publication.

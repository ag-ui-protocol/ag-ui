# Changelog

## 0.1.1 — 2026-09-09

- Added `REASONING("reasoning")` to the `Role` enum, enabling `Role.fromValue("reasoning")` to succeed.
- Added a `ReasoningMessage` type to the sealed `Message` hierarchy for representing reasoning in conversation history.
- `ReasoningMessage` carries an optional `encryptedValue`, retaining encrypted chain-of-thought reasoning across round trips.
- Existing `(id, content)` and `(id, content, name)` constructors are preserved; `ReasoningMessageStartEvent` can now carry the `role: "reasoning"` field.

### Breaking changes

- The sealed `Message` hierarchy gains a new `ReasoningMessage` variant; exhaustive switches over `Message` must handle it.

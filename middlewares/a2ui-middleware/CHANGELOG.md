# Changelog

## 0.0.16 — 2026-11-12

- Maintenance release; no consumer-facing changes identified.

### Breaking changes

None.

## 0.0.15 — 2026-11-10

- Preserve exhausted recovery state after streaming completes.
- Consume legacy approval before continuation to avoid duplicate handling.
- Preserve action context identity across adapters.
- Keep context visibility stable across serialization and event representations.
- Protect private context so action context stays out of the public transcript.
- Represent UI actions as user input in signed model history.
- Settle malformed generation at stream termination.

### Breaking changes

- Action context is now excluded from the public transcript; re-verify any code reading it there.
- UI actions appear as user input in signed model history; re-verify history consumers.
- Context serialization and visibility behavior changed; re-verify serialized output.

## 0.0.14 — 2026-10-21

- Completed SDK middleware tools.
- Retain recovery input across middleware processing.

### Breaking changes

None.

## 0.0.13 — 2026-10-19

- Preserve custom wrapper defaults with opt-in disambiguation for nested rendering.
- Add optional `a2uiGenerationToolNames` field to `A2UIMiddlewareConfig` to distinguish nested generation wrappers from ordinary tools.
- Stop inferring nesting from differing assistant message IDs; keep same-message calls and sibling surfaces separate.
- Preserve missing-identity nested recovery fallback, including after outer argument streaming ends.
- Clarify custom wrapper migration and ancestry limits in docs.

### Breaking changes

None.

## 0.0.12 — 2026-10-05

- Fixed recovery to resume unanswered render calls before native continuation.
- Aligned recovery resume behavior with injected tool names.

### Breaking changes

None.

## 0.0.11 — 2026-09-30

- Fixed parallel tool surfaces to stay associated with their own calls.
- Action tool IDs now fit within provider length limits.
- Bounded derived action identifier lengths.
- Preserved action identities when retrying a run.
- Documented the parallel call limitation.

### Breaking changes

- Built on @ag-ui/core 1.0 generated types; 0.x names are now deprecated aliases (see DEPRECATIONS.md).
- Re-verify integration with the new post-middleware enforcement pipeline and protobuf wire.

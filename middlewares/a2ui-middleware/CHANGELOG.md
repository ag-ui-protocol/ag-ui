# Changelog

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

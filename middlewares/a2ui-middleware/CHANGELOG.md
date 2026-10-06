# Changelog

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

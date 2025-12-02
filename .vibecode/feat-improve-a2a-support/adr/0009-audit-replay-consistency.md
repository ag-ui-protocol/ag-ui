# ADR 0009: Audit, Replay, and Multi-Agent Consistency

**Status**  
Accepted

**Date**  
2025-11-29

## Context

We need strong provenance and replay for config and domain changes across humans and agents.

## Decision

- Treat A2A Message history plus Task lifecycle (including Artifacts) as the canonical audit log.
- All meaningful config changes become Engram messages; no silent in-process mutations.
- Domain/view changes are represented in Task status and Artifacts, not hidden UI state.
- Other agents use the same Engram mechanism as AG-UI for consistency.
- Message-only agents remain valid: when only `kind: "message"` text parts are emitted, they continue to render as assistant messages; artifact/status handling is additive for richer agents.

## Consequences

- Full provenance of who/when/what for config and domain state.
- Reliable replay from initial state plus message/Artifact history.
- Shared contract enables multi-agent orchestration without special-casing UI.

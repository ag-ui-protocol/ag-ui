# ADR 0010: A2A -> AG-UI Shared State via Tasks and Artifacts

**Status**  
Accepted

**Date**  
2025-11-29

## Context

AG-UI shared state must be driven from A2A outputs without treating artifacts as implicit commands.

## Decision

- Tasks + Artifacts are the primary source for projecting A2A outputs into AG-UI shared state.
- Text artifacts stream as assistant messages by default (one per artifactId, honoring `append` and `lastChunk`).
- JSON/structured artifacts map to shared-state paths (for example, `/view/portfolio`) as snapshots or append deltas based on `append` and `lastChunk`.
- Artifacts are projections of task/domain state or config views; they are not config-mutation commands, which always arrive via Engram Messages on the input path.
- Backwards-compatible baseline: if agents only emit `kind: "message"` text parts, projection stays as the current text-message path; artifact-aware projection is additive when agents provide status/artifact events.

## Consequences

- Shared state stays aligned with task/artifact history.
- Streaming semantics (`append`, `lastChunk`) control snapshot vs append behavior.
- Clear separation between config mutation (Engram messages) and view projection (artifacts).

# ADR 0011: Implicit vs Explicit Semantics for A2A Agents

**Status**  
Accepted

**Date**  
2025-11-29

## Context

The AG-UI gateway must provide sensible defaults for arbitrary A2A agents while allowing richer projections for agents that opt in to metadata conventions.

## Decision

- Support implicit defaults for generic agents: first text artifact renders as the primary assistant message; other text artifacts become additional messages/results; JSON artifacts render as generic result/JSON panels and are projected into shared state via safe defaults (for example, `/view/artifacts/<artifactId>` or `/view/results/...`). `append: false` snapshots replace the projection subtree; `append: true` appends; `lastChunk: true` closes streaming for that artifact.
- Support explicit semantics for cooperative agents: artifacts may carry metadata (kind/scope/path/uiKind) indicating projection targets and snapshot vs append behavior.
- Agent config/knobs remain explicit: use Engram extension Messages for config mutation; artifacts do not implicitly change agent configuration.

## Consequences

- Safe, useful baseline experience for any A2A agent.
- Rich, precise shared-state projection when agents provide explicit metadata.
- Prevents accidental config mutations via artifacts while enabling structured views.

# ADR 0011: Implicit vs Explicit Semantics for A2A Agents

**Status**  
Proposed

**Date**  
2025-11-29

## Context

The AG-UI gateway must provide sensible defaults for arbitrary A2A agents while allowing richer projections for agents that opt in to metadata conventions.

## Decision

- Support implicit defaults for generic agents: first text artifact renders as the primary assistant message; other text artifacts become additional messages/results; JSON artifacts render as generic result/JSON panels and may be projected via safe heuristics; no artifact is treated as a config mutation.
- Support explicit semantics for cooperative agents: artifacts may carry metadata (kind/scope/path/uiKind) indicating projection targets and snapshot vs append behavior.

## Consequences

- Safe, useful baseline experience for any A2A agent.
- Rich, precise shared-state projection when agents provide explicit metadata.
- Prevents accidental config mutations via artifacts while enabling structured views.


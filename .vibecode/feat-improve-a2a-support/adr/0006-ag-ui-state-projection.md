# ADR 0006: AG-UI Shared State as Projection

**Status**  
Proposed

**Date**  
2025-11-29

## Context

AG-UI maintains shared state, but agent behavior must be driven by canonical A2A state/config, not by UI-local mutations.

## Decision

- Treat AG-UI shared state as a projection/view, not the source of truth.
- Partition AG-UI state into a config slice (mirrors agent config), a view/data slice (mirrors Task/domain state), and UI-only fields.
- When AG-UI state changes, the bridge computes semantic deltas for the config slice and emits state-control Messages (ADR 0005); view/data stay driven by Task/Artifact updates; UI-only fields stay local.

## Consequences

- Agent behavior stays anchored to A2A state while UI remains responsive.
- Config changes are explicit, auditable messages; view data flows from Tasks/Artifacts.
- UI-only concerns avoid polluting agent-facing protocols.


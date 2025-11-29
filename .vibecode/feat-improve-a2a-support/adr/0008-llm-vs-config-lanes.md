# ADR 0008: LLM Lane vs Config Lane

**Status**  
Proposed

**Date**  
2025-11-29

## Context

Agent inputs may be conversational or imperative config changes; these require different handling paths.

## Decision

- Messages without the state-control extension flow through the LLM/planner/workflow lane as conversational or high-level control input.
- Messages with the state-control extension flow through a config lane: parse `agent_state_update`, apply config/task updates directly, and optionally emit derived context/system cues to the LLM.
- Task/domain state and UI projections return via Tasks + Artifacts, not via state-control output messages.

## Consequences

- Protects config mutations from LLM hallucinations and preserves intent.
- Keeps conversational inputs and config updates independent yet coordinated.
- Output side remains artifact-driven for consistent UI projections.


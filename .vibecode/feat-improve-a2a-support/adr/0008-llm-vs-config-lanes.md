# ADR 0008: LLM Lane vs Config Lane

**Status**  
Accepted

**Date**  
2025-11-29

## Context

Agent inputs may be conversational or imperative config changes; these require different handling paths. The A2A surface exposes a single message API (`message.send` / `message.stream`) plus Task/Artifact outputs, so lane selection must be encoded in the message itself (via extensions/metadata) without inventing a second protocol.

## Decision

- Messages without the Engram extension flow through the LLM/planner/workflow lane as conversational or high-level control input—these ride the standard A2A message pipeline unchanged.
- Messages with the Engram extension flow through a config lane: parse `agent_state_update`, apply config/task updates directly on the A2A server/agent state, and optionally emit derived context/system cues to the LLM (still via the A2A message stream, not a side channel).
- Task/domain state and UI projections return via Tasks + Artifacts, not via Engram output messages; the same applies to config views that the agent chooses to surface back to AG-UI, preserving the A2A output contract.
- If no Engram extension is present, inputs stay in the LLM/conversational lane and default projection semantics apply; adding Engram is opt-in for explicit config control and is the only way to request state/config mutation over A2A.

## Consequences

- Protects config mutations from LLM hallucinations and preserves intent.
- Keeps conversational inputs and config updates independent yet coordinated.
- Output side remains artifact-driven for consistent UI projections.

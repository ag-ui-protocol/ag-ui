# ADR 0005: Config/Control via Engram Extension

**Status**  
Proposed

**Date**  
2025-11-29

## Context

We need a structured way to mutate agent/task configuration via A2A without overloading Secure Passport or leaking UI specifics.

## Decision

- Use a custom A2A extension (for example, `urn:our-platform:engram:v1`) for config/control updates.
- Messages with the Engram extension carry structured deltas (for example, JSON Patch ops) indicating scope (`task`, `context`, or `agent`).
- Agents apply these messages directly to internal config/state and may emit derived system/context cues to the LLM if needed.
- Advertise the extension in AgentCard capabilities; use it for other agents and for AG-UI bridge emissions when config-relevant shared state changes.
- Do not repurpose Secure Passport; Passport remains caller context, while the Engram extension mutates callee configuration.
- Agents surface **config views** back to AG-UI via Task Artifacts (for example, JSON snapshots of current config); Engram is input-only for config mutation.

## Consequences

- Clear, auditable path for config changes across UI and agents.
- Separation of identity/context (Passport) from imperative config updates.
- Enables multi-agent config adjustments with the same contract.

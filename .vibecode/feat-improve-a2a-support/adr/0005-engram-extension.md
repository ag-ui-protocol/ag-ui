# ADR 0005: Config/Control via Engram Extension

**Status**  
Superseded by ADR 0014 & ADR 0020

**Date**  
2025-11-29

## Context

We need a structured way to mutate agent/task configuration via A2A without overloading Secure Passport or leaking UI specifics.

## Decision

- Superseded: ADR 0014 redefines Engram as the domain-state extension with canonical RPC surface and task-based streaming; ADR 0020 sets the versioned extension URI and activation model.
- Previous guidance (URN-style Engram, message-only config lane) is retained here for historical context but is not normative after 2025-12-05.

## Consequences

- Historical only; see ADR 0014–0020 for the current Engram design and extension URI.

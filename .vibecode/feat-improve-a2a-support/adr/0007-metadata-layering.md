# ADR 0007: Metadata Layering (Keep AG-UI Details Internal)

**Status**  
Accepted

**Date**  
2025-11-29

## Context

We must prevent AG-UI-specific metadata from leaking into external A2A interactions while still routing messages correctly inside the agent.

## Decision

- Keep AG-UI-specific metadata (for example, source, threadId, runId) inside the AG-UI <-> A2A bridge.
- External A2A clients see plain messages and known extensions (such as Engram), not AG-UI markers.
- Inside the agent, routing uses semantic markers (extension URIs, DataPart `kind`) rather than origin-specific UI metadata.

## Consequences

- Clean separation between UI session details and A2A semantics.
- Reduces coupling and surprises for third-party agents.
- Agent internals route on stable protocol markers instead of UI provenance.

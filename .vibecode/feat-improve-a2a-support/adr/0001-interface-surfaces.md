# ADR 0001: Interface Surfaces (A2A vs AG-UI vs REST)

**Status**  
Accepted

**Date**  
2025-11-29

## Context

The platform needs clear, canonical interaction surfaces for humans and machines without fragmenting the cognitive surface across protocols.

## Decision

- A2A is the canonical machine interface; other agents, CLIs, and jobs interact only via A2A Messages/Tasks and extensions.
- AG-UI is the canonical human interface; frontends use Runs, events, and shared state to talk to agents.
- No bespoke REST/gRPC for cognitive/agent behavior; REST/gRPC are reserved for platform/admin/infra (multi-tenant ops, analytics, internal tools).

## Consequences

- Single machine interface simplifies interoperability and extension discovery.
- Human flows stay on AG-UI abstractions without leaking UI concerns into A2A.
- Avoids split-brain behavior between REST and A2A for core agent semantics.


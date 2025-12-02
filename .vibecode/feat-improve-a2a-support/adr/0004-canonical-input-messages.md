# ADR 0004: Canonical Input as Messages

**Status**  
Accepted

**Date**  
2025-11-29

## Context

Inputs that affect agent behavior (from users or agents) must be normalized to A2A semantics to keep auditability and multi-agent consistency.

## Decision

- Everything that matters to agent behavior is expressed as an A2A Message with appropriate `parts`, `extensions`, and `metadata`.
- Covers conversational input, HITL approvals/rejections, mid-flight injections, config/setting changes, and workflow toggles/filters.
- Long-lived task/domain state is represented via Tasks + Artifacts; AG-UI does not send state blobs directly as truth.

## Consequences

- Uniform ingestion path simplifies reasoning, auditing, and replay.
- Prevents hidden state mutations outside the A2A message log.
- Aligns UI and other agents on the same contract.


# ADR 0004: Canonical Input as Messages

**Status**  
Accepted

**Date**  
2025-11-29

## Context

Inputs that affect agent behavior (from users or agents) must be normalized to A2A semantics to keep auditability and multi-agent consistency.

## Decision

- Everything that matters to agent behavior is expressed as an A2A Message with appropriate `parts`, `extensions`, and `metadata`.
- Covers conversational input, input-required approvals/rejections, mid-flight injections, config/setting changes, and workflow toggles/filters.
- Clients send the current message only; do not resend the full conversation transcript. The A2A service owns task history and context storage.
- Optional cues (system/developer/config, input resume payloads) may be attached to the current message when explicitly enabled, but are not a substitute for server-side history.
- Long-lived task/domain state is represented via Tasks + Artifacts; AG-UI does not send state blobs directly as truth.

## Consequences

- Uniform ingestion path simplifies reasoning, auditing, and replay.
- Prevents hidden state mutations outside the A2A message log.
- Aligns UI and other agents on the same contract.

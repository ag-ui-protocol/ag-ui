# Product Requirements Document: Engram Client Integration in A2AAgent (ADR‑0014–0020)

Created: 2025-12-05T00:00:00Z  
Status: Approved  
Branch: feat/improve-a2a-support

## Overview

Implement Engram v0.1 on the client side within A2AAgent and ag-ui, aligning with ADRs 0014–0020, with the primary goal of keeping AG-UI shared state in sync with A2A state. The work is limited to client behavior, headers, RPC calling surfaces, subscription handling, and tests that exercise a reference in-memory Engram server. No persistent or server-side storage changes will be made. Any prior Engram client behavior must be superseded by the ADR-aligned spec without breaking existing non-Engram features or currently passing tests.

## Business Requirements

### Objectives

- Provide A2AAgent clients with a complete Engram v0.1 interaction surface (RPC + subscriptions) per ADR 0014–0020.
- Ensure AG-UI shared state remains synchronized with A2A state via Engram events (snapshots/deltas) when enabled, while preserving current behavior for non-Engram flows.
- Ensure Engram usage is explicitly activated via the extension URI while preserving current behavior for non-Engram flows.
- Enable developers to test Engram client flows against a lightweight in-memory A2A server Engram implementation.

### User Stories

- As a client developer, I can call Engram RPCs via A2AAgent with proper request/response typing and CAS error handling.
- As a UI integrator, I can enable Engram per-request using the extension URI header and see Engram subscription updates in task streams.
- As a maintainer, I can run the test suite and confirm no regressions to existing (non-Engram) behavior while the Engram client follows the latest ADR spec.

## Success Criteria

- [ ] A2AAgent exposes Engram RPC helpers (`get`, `list`, `set`, `patch`, `delete`, `subscribe`) that map to ADR‑0016/0017 semantics, including JSON Patch deltas and `expectedVersion` CAS.
- [ ] Engram remains **optional** for A2AAgent: activation is controlled by an explicit flag when instantiating A2AAgent (default off), with per-call opt-in/override; non-Engram flows behave identically to today.
- [ ] Engram activation uses the canonical extension URI `https://github.com/EmberAGI/a2a-engram/tree/v0.1` via `X-A2A-Extensions` on Engram-dependent requests; responses surface activation echo or errors.
- [ ] Subscriptions return a `taskId` and stream EngramEvents (`snapshot`/`delta`/`delete`) over Task artifacts; the client reattaches via `tasks/resubscribe` or starts a new `engram/subscribe` with `fromSequence` as needed. Events flow through the existing A2AAgent event stream (no new subscription interface added).
- [ ] Message-embedded Engram ops remain optional; if unsupported by the server, the client degrades gracefully without affecting non-Engram flows.
- [ ] All existing passing tests remain green; only prior Engram-specific behavior is superseded. No regressions in other A2AAgent features.
- [ ] New tests cover Engram RPCs and subscriptions using a memory-backed test server; they validate activation (ctor flag + per-call), CAS conflicts, JSON Patch application client-side expectations, subscription resume semantics, and ag-ui `STATE_SNAPSHOT` / `STATE_DELTA` handling to keep AG-UI shared state in sync with A2A when Engram is enabled (reuse existing AG-UI client snapshot/delta test patterns; add cases only if gaps remain).

## Technical Requirements

### Functional Requirements

- Implement client-side Engram key/record types per ADR‑0015, including `labels`/`tags` as opaque metadata.
- RPC helpers:
  - `engram/get` & `engram/list` with key prefix and `updatedAfter` filters plus pagination tokens.
  - `engram/set` full upsert with optional `expectedVersion`.
  - `engram/patch` applying JSON Patch to `record.value`, CAS via `expectedVersion`.
  - `engram/delete` with optional CAS, returning prior version metadata.
- Subscription helper:
  - `engram/subscribe` accepts filter, `includeSnapshot`, optional `fromSequence`, optional `contextId`; returns `taskId`.
  - Stream parsing of EngramEvents from Task artifacts; enforce sequence monotonicity client-side and expose consumer callbacks.
  - Resume via `tasks/resubscribe`; fallback to new subscribe with `fromSequence` if needed.
- Activation:
  - Constructor-level Engram enable flag (default off) controls whether Engram helpers add the extension URI; allow per-call override.
  - Surface clear error when server lacks Engram support or activation header is missing.
- Compatibility:
  - Preserve existing A2AAgent behaviors and signatures; any changes limited to Engram-specific paths or additive options.

### Non-Functional Requirements

- Performance: client processing of subscription streams should avoid blocking UI threads; support backpressure-friendly consumption (e.g., async iterator or event callbacks).
- Reliability: retries/resubscribe flows must not duplicate events out of order; document at-least-once expectations with `sequence` handling.
- Observability: add debug logging/metrics hooks for Engram RPC calls, CAS conflicts, subscription reconnects, and activation failures (honoring existing log level controls).
- Testability: memory-backed server fixtures for Engram RPCs and subscriptions; deterministic sequences for resume testing.

## Integration Points

- A2AAgent core request pipeline: header insertion for `X-A2A-Extensions`, error handling, and response echo propagation.
- Task streaming client: artifact parsing to extract EngramEvents; reuse existing task subscribe/resubscribe plumbing and the current A2AAgent event stream surface (no new subscription API).
- Type definitions shared with ag-ui UI components for displaying Engram data and statuses, including compatibility with `STATE_SNAPSHOT` and `STATE_DELTA` flows.
- Test harness: integration tests using in-memory A2A server Engram stub; vitest setup aligning with project testing strategy.

## Constraints & Considerations

### Technical Constraints

- No server/storage implementation changes; only client logic and tests using a memory store fixture.
- JSON Patch is mandatory for deltas; alternative delta formats are out of scope.
- Must maintain current non-Engram behavior and passing tests; only prior Engram client behaviors may change to align with ADRs.

### Business Constraints

- Internal project: minimize regressions to existing flows; release should be low-risk for current users of A2AAgent.

### Risks

- Missing activation header could yield silent mismatches if not validated; need explicit client checks.
- Sequence handling errors could cause duplicate or skipped events on resume.
- Optional message-embedded ops could fragment behavior if partially implemented; ensure clear enable/disable path (currently deferred).
- Incorrect handling of `STATE_SNAPSHOT` / `STATE_DELTA` mapping to Engram events could cause UI state divergence when Engram is enabled.

## Architectural Decisions (require documentation/approval before rationales.md entry)

### Decision 1: Default Engram Activation Behavior

- **What**: Constructor-level flag controls Engram activation (default off); per-call override allowed.
- **Why**: Prevents unintended activation while giving a single opt-in point for Engram use cases.
- **Alternatives**: Auto-on for Engram methods; per-call flags only; global toggle default on.
- **Trade-offs**: Constructor flag is explicit and ergonomic; avoids surprises to non-Engram callers.
- **Requires documentation in rationales.md**: Yes.

### Decision 2: Subscription Resume Strategy

- **What**: Client policy for resume—attempt `tasks/resubscribe` first, then new `engram/subscribe` with `fromSequence`, surfaced through the existing RxJS Observable event stream (no new subscription API).
- **Why**: Ensures predictable recovery without event loss or duplication.
- **Alternatives**: Always new subscribe with `fromSequence`; configurable strategy.
- **Trade-offs**: Reuse preserves task continuity; new subscribe simplifies but may lose artifacts if retention is short.
- **Requires documentation in rationales.md**: Yes.

### Decision 3: Message-Embedded Engram Ops Support

- **What**: Defer implementation of optional message-embedded Engram operations; keep RPC-only for v0.1 client.
- **Why**: Reduce surface area and test burden while spec marks them non-normative.
- **Alternatives**: Implement behind feature flag; implement unconditionally.
- **Trade-offs**: Deferral limits flexibility but reduces immediate complexity.
- **Requires documentation in rationales.md**: Yes (noting deferral).

## Out of Scope

- Any persistent Engram storage or server-side changes; production data durability is not addressed here.
- Migration of existing task artifacts into Engram records.
- UI design/UX polish beyond necessary controls for activation and subscription visibility.
- Non-JSON Patch delta formats or alternative versioning schemes.

## Open Questions

1. Minimal memory-store test fixture: define concrete shape to cover CAS conflicts, subscription resume, and `STATE_SNAPSHOT` / `STATE_DELTA` flows (to be proposed).

### Proposed Minimal Memory-Store Fixture (for tests)

- In-memory map keyed by `key: string` with fields `{ value: any, version: number, labels?: Record<string,string>, tags?: string[], createdAt, updatedAt }`.
- `set`: full replace; increments version; honors `expectedVersion` for CAS.
- `patch`: applies JSON Patch to `value`; increments version; honors `expectedVersion`.
- `delete`: removes entry; optional `expectedVersion`; returns prior version metadata.
- `list/get`: support exact key(s), `keyPrefix`, `updatedAfter`, and pagination token (opaque cursor over sorted keys).
- Subscriptions: per-subscription monotonic `sequence`; emit `snapshot` on subscribe when requested, `delta`/`delete` on mutations.
- Replay/resume: retain a small ring buffer of recent events/artifacts to cover `tasks/resubscribe`; on buffer miss, new `engram/subscribe` with `fromSequence` replays from the in-memory log (log size configurable per test).
- UI bridge: helper to emit ag-ui `STATE_SNAPSHOT` and `STATE_DELTA` derived from EngramEvents for assertions.

## Optional Sections

### Backwards Compatibility

- No breaking changes to existing non-Engram client behavior or passing tests. Changes that supersede prior Engram client behavior are allowed only to align with ADRs 0014–0020; other surfaces must remain compatible.

### Reference Patterns

- Follow existing A2A extension handling (e.g., Secure Passport/AP2) for header activation and capability advertisement in AgentCards.

### Security Analysis

- Reuse existing A2A authentication/authorization; ensure Engram activation does not bypass existing permission checks. Validate that Engram requests fail clearly when unauthorized or when the server lacks extension support.

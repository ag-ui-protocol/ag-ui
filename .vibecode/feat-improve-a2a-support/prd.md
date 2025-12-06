# Product Requirements Document: Engram Client Integration in A2AAgent (ADR‑0014–0020)

Created: 2025-12-05T00:00:00Z  
Status: Approved  
Branch: feat/improve-a2a-support

## Overview

Implement Engram v0.1 on the client side within A2AAgent and ag-ui, aligning with ADRs 0014–0020, with the primary goal of keeping AG-UI shared state in sync with A2A state. Engram is an internal concern of A2AAgent: runs translate Engram events into AG-UI `STATE_SNAPSHOT` / `STATE_DELTA` events. No new public Engram API surface is exposed beyond the existing `AbstractAgent` interface (`run` and its stream). The work is limited to internal client behavior, headers, subscription handling, and tests that exercise a reference in-memory Engram server. No persistent or server-side storage changes will be made. Any prior Engram client behavior must be superseded by the ADR-aligned spec without breaking existing non-Engram features or currently passing tests.

AG-UI interaction model:
- `run` is the only client→agent wire call. It carries `messages`, full `state` (client’s current shared state), and `forwardedProps` (adapter-specific intent).
- `STATE_SNAPSHOT` / `STATE_DELTA` only flow agent→client on the run stream; there is no dedicated “get state” RPC.
- Adapter-specific intent uses `forwardedProps` (ignored by core) to mark Engram hydration/sync modes.

## Deliverables

- Engram-enabled A2AAgent client with constructor flag (default off) that inserts the v0.1 extension header and drives Engram RPCs internally.
- Stream merge layer that converts Engram subscription artifacts into AG-UI `STATE_SNAPSHOT` / `STATE_DELTA` events, including resume/rehydrate flows.
- Memory-backed Engram server fixture (CAS, JSON Patch, subscription resume) used across Vitest suites.
- Vitest coverage for hydrate/sync/guardrails/resume/parallel stream behavior plus header activation and error surfacing.
- Developer notes/checklist for enabling Engram in local dev and tests (no public API docs; internal only).

### Run payload contracts (normative)

- Hydration (one-shot):
  - `messages: []`
  - `state: {}` (empty object)
  - `forwardedProps: { engram: { mode: "hydrate_once" } }`
  - `threadId`: optional; if present, the agent must accept it and scope Engram state to that thread.
- Hydration (streaming/default):
  - `messages: []`
  - `state: {}`
  - `forwardedProps: { engram: { mode: "hydrate_stream" } }`
  - Expect: initial `STATE_SNAPSHOT`, then `STATE_DELTA` events until the run is ended by the caller.
- UI→Agent sync:
  - `messages: []`
  - `state: <full shared state the UI currently holds>`
  - `forwardedProps: { engram: { mode: "sync" } }`
  - Expect: server applies the Engram slice of `state` and returns `STATE_SNAPSHOT` (overwrite) or `STATE_DELTA` (patch), then finishes the run.
- Guardrails: if `messages.length > 0` while `forwardedProps.engram.mode` is set, treat as an error (reject the run) to avoid mixing Engram-only and LLM work.
- Forward-compatibility: reject unknown `forwardedProps.engram.mode` values with a clear error surfaced on the run stream; do not fall back silently.

## Business Requirements

### Objectives

- Keep AG-UI shared state synchronized with A2A state by internally translating Engram events (snapshots/deltas) into AG-UI state events during `run`.
- Make Engram optional and opt-in at agent construction; default is off. When disabled, behavior matches current non-Engram flows.
- Ensure Engram usage is explicitly activated via the extension URI on Engram-dependent internal calls.
- Enable developers to test Engram-enabled runs against a lightweight in-memory A2A server Engram implementation.

### User Stories

- As a UI integrator, when I construct A2AAgent with Engram enabled, runs emit AG-UI `STATE_SNAPSHOT` and `STATE_DELTA` events derived from Engram streams so my shared state stays in sync.
- As a maintainer, I can run the test suite and confirm no regressions to existing (non-Engram) behavior while Engram handling follows ADR 0014–0020 internally.

### UI Playbook (explicit responsibilities)

- On mount (or when Engram data is needed), start a hydration run using the payload contract above. Accept either `hydrate_stream` (preferred) or `hydrate_once`.
- Replace local shared state with the first `STATE_SNAPSHOT` from that run. Do not merge; treat it as authoritative.
- For subsequent deltas on the same run, apply JSON Patch to local shared state. If patch application fails, log and request a fresh `hydrate_stream`.
- When the user changes Engram-bound UI data and needs persistence, start a sync run (payload contract above). Optimistically update local state first; server response will reconcile via snapshot or delta.
- Do not send user chat messages on Engram-only runs. If a UI path needs LLM plus Engram, issue a separate chat run without `engram.mode` or with non-empty messages (per existing behavior).

## Success Criteria

- [ ] Engram remains **optional** for A2AAgent: activation is controlled only by an explicit flag when instantiating A2AAgent (default off); no per-run override; non-Engram flows behave identically to today.
- [ ] Engram activation uses the canonical extension URI `https://github.com/EmberAGI/a2a-engram/tree/v0.1` via `X-A2A-Extensions` on Engram-dependent internal requests; responses surface activation echo or errors.
- [ ] Subscriptions return a `taskId` and stream EngramEvents (`snapshot`/`delta`/`delete`) over Task artifacts; the client reattaches via `tasks/resubscribe` or starts a new `engram/subscribe` with `fromSequence` as needed. Events flow through the existing A2AAgent run stream, emitting only AG-UI `STATE_SNAPSHOT` / `STATE_DELTA` events (no Engram-specific public interface). For Engram-enabled chat runs, the agent may maintain two internal streams (message stream + Engram subscription) and merge them for the caller.
- [ ] Message-embedded Engram ops remain optional; if unsupported by the server, the client degrades gracefully without affecting non-Engram flows.
- [ ] All existing passing tests remain green; only prior Engram-specific behavior is superseded. No regressions in other A2AAgent features.
- [ ] New tests cover Engram-enabled runs using a memory-backed test server; they validate activation (ctor flag), CAS conflicts, JSON Patch application client-side expectations, subscription resume semantics, hydrate/sync runs via `forwardedProps`, parallel stream merging, and AG-UI `STATE_SNAPSHOT` / `STATE_DELTA` handling to keep shared state in sync when Engram is enabled (reuse existing AG-UI client snapshot/delta test patterns; add cases only if gaps remain).

### Test Plan (must-cover cases)

1) Hydration (stream): empty `messages`, empty `state`, `engram.mode = "hydrate_stream"` → initial `STATE_SNAPSHOT` received, subsequent `STATE_DELTA` applied in order; no LLM/orchestrator calls.
2) Hydration (once): empty `messages/state`, `engram.mode = "hydrate_once"` → single `STATE_SNAPSHOT`, run finishes; race window acknowledged.
3) Sync: empty `messages`, full shared `state` provided, `engram.mode = "sync"` → server applies Engram slice, emits snapshot or delta, finishes run; UI reconciles; no LLM calls.
4) Guardrails: `messages.length > 0` + `engram.mode` → run rejected with clear error; `engram.mode` unknown → error; `messages.length === 0` without `engram.mode` → treated as non-Engram run.
5) Resume: drop/reconnect Engram subscription, resume via `tasks/resubscribe`, fall back to `engram/subscribe fromSequence`; sequences remain monotonic; no duplicates/skips.
6) JSON Patch application: deltas apply cleanly; failure surfaces a terminal `RUN_ERROR` and ends the stream (no auto-rehydrate); CAS conflict paths covered via memory-store fixture.
7) Parallel streams: Engram-enabled chat run merges message stream + Engram stream without interleaving errors; ordering preserved within each stream.
8) Header activation: Engram-enabled client sends `X-A2A-Extensions` URI; missing/unsupported server returns explicit error surfaced to caller.

## Technical Requirements

### Functional Requirements

- Implement client-side Engram key/record types per ADR‑0015, including `labels`/`tags` as opaque metadata.
- Internal Engram handling:
  - When Engram is enabled at construction, A2AAgent internally issues Engram RPCs (e.g., `engram/subscribe`, `tasks/resubscribe`) as needed to keep shared state synchronized; these are not exposed as public methods.
  - Stream parsing of EngramEvents from Task artifacts; enforce sequence monotonicity client-side and convert to AG-UI `STATE_SNAPSHOT` / `STATE_DELTA` events on the run stream.
  - Resume via `tasks/resubscribe`; fallback to new `engram/subscribe` with `fromSequence` if needed.
  - Support Engram-only runs using `forwardedProps.engram.mode`:
    - `hydrate_stream` (default): start `engram/subscribe includeSnapshot=true`, emit snapshot immediately, keep stream open for deltas; run finishes when caller ends it.
    - `hydrate_once`: one-shot `engram/get`, emit single `STATE_SNAPSHOT`, finish run (race window accepted).
    - `sync` (UI→agent): use incoming `state` (UI’s view) to upsert/patch/delete Engram records, then emit `STATE_SNAPSHOT` or `STATE_DELTA`, finish run; no LLM/chat work.
  - For Engram-enabled chat runs, maintain two internal streams (message stream + Engram subscription) and merge outputs into a single AG-UI event stream.
  - Agent guardrails:
    - If `forwardedProps.engram.mode` is present and `messages.length === 0`, skip orchestrator/LLM entirely.
    - If `forwardedProps.engram.mode` is present and `messages.length > 0`, reject the run with a clear error (do not partially process).
    - If `forwardedProps.engram.mode` is absent and `messages.length === 0`, treat as a normal non-Engram run (no-op Engram behavior).
    - Unknown `forwardedProps.engram.mode` values must surface an error on the run stream and terminate the run.
- Activation:
  - Constructor-level Engram enable flag (default off) controls whether internal Engram calls add the extension URI; no per-run override.
  - Surface clear error when server lacks Engram support or activation header is missing.
- ForwardedProps contract:
  - Accepted modes: `hydrate_stream`, `hydrate_once`, `sync`.
  - Shape: `forwardedProps: { engram: { mode: string } }`; additional fields MUST be ignored but preserved when echoing (future-proofing).
  - Validation: missing `engram.mode` on Engram-only runs is an error; unknown modes are errors.
  - Namespacing: `engram` key is reserved for this feature; other keys remain untouched by Engram logic.
- State semantics:
  - Incoming `state` on a run is the UI’s entire current shared state object (not a diff/patch); the agent must treat it as “what the UI believes right now.”
  - For sync runs, only the `state.engram` slice is applied to Engram; other branches are ignored by Engram logic but must pass through untouched.
  - Agent may emit either full shared state snapshots or Engram-only snapshots; if Engram-only, the UI must replace `state.engram` while preserving other branches.
  - Deltas emitted to the UI must be valid JSON Patch operations relative to the last acknowledged state.
- Compatibility:
  - Preserve existing A2AAgent behaviors and signatures; no new public Engram methods are added.

### Non-Functional Requirements

- Performance: client processing of subscription streams should avoid blocking UI threads; support backpressure-friendly consumption (e.g., async iterator or event callbacks).
- Reliability: retries/resubscribe flows must not duplicate events out of order; document at-least-once expectations with `sequence` handling.
 - Reliability: retries/resubscribe flows must not duplicate events out of order; document at-least-once expectations with `sequence` handling. JSON Patch failures are terminal (`RUN_ERROR`) rather than auto-rehydrate.
- Observability: add debug logging/metrics hooks for Engram RPC calls, CAS conflicts, subscription reconnects, and activation failures (honoring existing log level controls).
- Testability: memory-backed server fixtures for Engram RPCs and subscriptions; deterministic sequences for resume testing.

## Integration Points

- A2AAgent core request pipeline: header insertion for `X-A2A-Extensions`, error handling, and response echo propagation.
- Task streaming client: artifact parsing to extract EngramEvents; reuse existing task subscribe/resubscribe plumbing and the current A2AAgent event stream surface (no new subscription API).
- Type definitions shared with ag-ui UI components for displaying Engram data and statuses, including compatibility with `STATE_SNAPSHOT` and `STATE_DELTA` flows.
- Test harness: integration tests using in-memory A2A server Engram stub; vitest setup aligning with project testing strategy.

## Assumptions & Dependencies

- Server side exposes Engram v0.1 RPCs and honors `X-A2A-Extensions` with `https://github.com/EmberAGI/a2a-engram/tree/v0.1`; unsupported responses are explicit errors, not silent ignores.
- JSON Patch utility already available in the client stack; no alternative delta codecs are introduced.
- Existing AG-UI shared-state event wiring remains unchanged; Engram work only maps to the current `STATE_SNAPSHOT` / `STATE_DELTA` protocol.
- Tests run against the memory-backed Engram fixture; no external services are required beyond current A2A test infrastructure.

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

- **What**: Constructor-level flag controls Engram activation (default off); no per-run override.
- **Why**: Keeps activation explicit and stable over the agent’s lifetime; avoids inconsistent behavior across runs.
- **Alternatives**: Per-run flags; auto-on; global toggle default on.
- **Trade-offs**: Constructor flag is explicit and ergonomic; avoids surprises to non-Engram callers.
- **Requires documentation in rationales.md**: Yes.

### Decision 2: Subscription Resume Strategy

- **What**: Client policy for resume—attempt `tasks/resubscribe` first, then new `engram/subscribe` with `fromSequence`, surfaced through the existing RxJS Observable event stream (no new subscription API; Engram and message streams may be parallel and merged).
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

## Resolved Details

1. Minimal memory-store test fixture: adopt the proposed fixture below as normative for tests (CAS, resume, snapshot/delta coverage are required).
2. Hydration modes: support both; default expectation is `hydrate_stream` for production; `hydrate_once` allowed for simple screens/tests with accepted race window.
3. Backpressure/termination: rely on existing run cancellation plus async iterator/Observable backpressure; no additional API surface required.

### Minimal Memory-Store Fixture (normative for tests)

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

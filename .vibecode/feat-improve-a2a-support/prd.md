# Product Requirements Document: A2A Integration Alignment with ADRs

Created: 2025-11-29T20:45:00Z
Status: Draft
Branch: feat/improve-a2a-support

## Overview

Align the TypeScript A2A bridge with the new ADR set so AG-UI can run both short-lived and long-lived A2A tasks, project artifacts/status into shared state, and support the Engram config lane while preserving the current text-only path for legacy agents.

## Business Requirements

### Objectives

- Provide reliable interoperability between AG-UI runs and A2A tasks, including streaming, injections, and reconnections.
- Preserve existing text-message behavior for agents that only emit message events.
- Enable richer agents to project artifacts/status into shared state and accept config changes via Engram without breaking legacy callers.

### User Stories

- As an operator, I can run long-lived A2A tasks in AG-UI and inject mid-flight updates without losing the task timeline.
- As an agent integrator, my existing text-only A2A agent continues to function without changes.
- As a platform engineer, I can send config updates through Engram messages and see resulting state views via artifacts/status updates.

## Success Criteria

- [ ] Run invocation supports `mode: "send" | "stream"` and optional `taskId`, with long-lived subscriptions for streaming and short-lived control runs for injections/reconnects per ADR 0002/0003.
- [ ] AG-UI → A2A conversion forwards all relevant messages (user, assistant, system/developer when needed) and preserves context/config inputs instead of dropping them; latest user message is not the sole payload.
- [ ] Engram extension is supported (opt-in): messages carrying the Engram URN are routed to the config lane; absence of Engram uses conversational defaults with unchanged text rendering.
- [ ] A2A outputs (messages, status, artifacts) map to AG-UI events: message parts still emit text/tool events as today; artifacts/status updates project into shared state or activity events per ADR 0009/0010/0011.
- [ ] Metadata layering prevents leaking AG-UI-only identifiers (threadId/runId) into external A2A payloads; context/task identifiers are used consistently for A2A addressing.
- [ ] Legacy compatibility: when an agent emits only `kind: "message"` text parts, AG-UI behavior matches current output (assistant text/tool events only).
- [ ] Reconnect/resubscribe uses A2A task snapshot APIs (for example, `task/get`) to recover current task state, then resumes streaming without reopening closed runs.
- [ ] System/developer messages are gated by default; forwarding requires explicit opt-in and remaps to A2A’s `user`/`agent` roles with clear extension/metadata tagging.
- [ ] HITL flow: when A2A emits `TaskState.input_required` with TextPart + `DataPart { type: "a2a.hitl.form" }`, bridge emits final assistant message + `RUN_FINISHED` with `outcome: "interrupt"` and interrupt payload; resume via new run with `resume` payload sends `a2a.hitl.formResponse` and continues streaming to completion.
- [ ] Activity/State projection for HITL: emit `ACTIVITY_SNAPSHOT`/`ACTIVITY_DELTA` and `STATE_DELTA` patches to represent pending interrupts and task status; state shape uses plural maps (for example, `/view/tasksById`, `/view/pendingInterrupts`).

## Technical Requirements

### Functional Requirements

- Implement RunOptions with mode and taskId; map `stream` to long-lived subscription runs and `send` to short-lived sends or injections.
- Support reconnect/resubscribe flows using task snapshots/status/messages rather than reopening closed runs.
- Convert AG-UI message history into A2A messages without dropping system/developer/config cues when relevant; avoid latest-only payloading.
- Add Engram extension handling: recognize Engram URN, route to config lane, and emit structured config deltas; keep conversational lane unchanged when Engram is absent.
- Retire legacy `https://a2ui.org/ext/a2a-ui/v0.1` header; Engram becomes the single extension for config/control across AG-UI and other callers.
- Convert A2A status and artifact events into AG-UI events/shared state projections, including streaming semantics (`append`, `lastChunk`).
- Maintain existing text-message chunk/tool-call mapping for A2A `kind: "message"` parts.
- Ensure surface/activity updates use stable identifiers and avoid duplicating snapshots/deltas.
- Define default JSON artifact projection path when explicit metadata is absent (set to `/view/artifacts/<artifactId>` with snapshot vs append governed by `append`/`lastChunk`).
- HITL interrupt/resume: on `input_required`, stop streaming for the run, emit assistant MESSAGE + `RUN_FINISHED` (interrupt payload carries form), and project state/activity; on resume, send `DataPart { type: "a2a.hitl.formResponse" }` to same `taskId`, then continue normal streaming.
- Activity events: emit `ACTIVITY_SNAPSHOT` (activityType e.g., `HITL_FORM`) with form content and stable `messageId` per interrupt; emit `ACTIVITY_DELTA` patches to update stage/decision upon resume/completion.
- State events: emit initial `STATE_SNAPSHOT` and subsequent `STATE_DELTA` JSON Patch arrays maintaining maps like `/view/tasksById/<taskId>` and `/view/pendingInterrupts`.

### Non-Functional Requirements

- Preserve performance of current text-only flows; added projection logic must not materially degrade latency for streaming.
- Maintain strict TypeScript typings; avoid `any`.
- Compatible with current A2A SDK expectations for context/task identifiers and extension headers.

## Integration Points

- AG-UI client run/event model (`@ag-ui/client`) for emitting RunStarted/RunFinished, text/tool/activity/shared-state events.
- A2A SDK client (`@a2a-js/sdk`) for `message.send`, `message.stream`, task resubscribe, and extension handling.
- AG-UI shared state projection mechanisms for artifacts/status/activity events.

## Constraints & Considerations

### Technical Constraints

- Must work with existing A2A SDK capabilities; custom extensions require explicit URNs.
- No dotenv usage; env loading via Node native flags.
- pnpm-only tooling; TypeScript ES2022/NodeNext.

### Business Constraints

- Backwards-compatible experience for message-only agents is required; richer behavior is additive.

### Risks

- Misaligned identifiers (threadId vs contextId/taskId) could leak UI provenance or break reconnections.
- Engram URN semantics need agreement; lack of consensus could stall config-lane adoption.
- Artifact projection might introduce unexpected UI changes if defaults aren’t clearly scoped to implicit vs explicit agents.
- HITL UX depends on consistent Activity/State emissions; gaps could leave UI without pending-approval context.

### ADR Structure (reference)

- ADRs live in `.vibecode/feat-improve-a2a-support/adr/` with index at `adl.md`; current set is 0001–0012 (interface surfaces, run/task mapping, run modes, canonical input, Engram, AG-UI state projection, metadata layering, LLM vs config lanes, audit/replay, artifacts→shared state, implicit vs explicit semantics, HITL interrupts + Activity/State).

## Architectural Decisions

### Decision 1: A2A Context/Task Identifier Strategy (requires approval)

- **What**: Define how AG-UI threadId/runId map (or do not map) to A2A contextId/taskId across send/stream, injections, and reconnects.
- **Why**: Avoid leaking UI identifiers while ensuring stable addressing and replay per ADR 0002/0007.
- **Alternatives**: (a) Derive contextId from taskId and never use threadId externally; (b) allow threadId passthrough when taskId absent; (c) generate bridge-owned contextId per task.
- **Trade-offs**: Stability vs provenance leakage; simplicity vs multi-task-per-thread support.
- **Requires documentation in ADR**: Yes.

### Decision 2: Engram URN and Handling (requires approval)

- **What**: Choose the Engram extension URN and routing rules for config lane vs conversational lane, including capability advertisement.
- **Why**: ADR 0005/0008 require explicit config mutation path; current code has only a legacy, undefined extension header.
- **Alternatives**: (a) Introduce new URN per ADR; (b) repurpose existing header; (c) dual advertise but only act on new URN.
- **Trade-offs**: Clarity vs compatibility; risk of unused legacy header vs migration effort.
- **Requires documentation in ADR**: Yes.

### Decision 3: Artifact/Status Projection Defaults (requires approval)

- **What**: Define default projection paths/behaviors for text and JSON artifacts/status when explicit metadata is absent.
- **Why**: ADR 0010/0011 call for safe defaults while supporting richer metadata-driven projections.
- **Alternatives**: (a) Minimal projection (message-only); (b) generic `/view/artifacts/<id>`; (c) configurable mapping by agent card metadata.
- **Trade-offs**: Safety vs usefulness; predictability vs richness.
- **Requires documentation in ADR**: Yes.

## Out of Scope

- Changes to non-TypeScript A2A integrations.
- UI/UX redesign of AG-UI views; focus is bridge semantics and event projection.
- Recording new mocks or external API changes.

## Open Questions

None currently.

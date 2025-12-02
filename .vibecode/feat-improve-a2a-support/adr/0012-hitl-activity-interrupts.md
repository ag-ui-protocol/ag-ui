# ADR 0012: HITL Interrupts via A2A `input_required` + AG-UI Activity/State

**Status**  
Accepted

**Date**  
2025-12-01

## Context

- We now need first-class human-in-the-loop (HITL) handling while keeping A2A the source of truth and AG-UI as a projection (ADR 0004, ADR 0006, ADR 0010).
- A2A expresses HITL pauses via `TaskState.input_required` and DataPart payloads; AG-UI surfaces pauses via interrupts/resume plus Activity/State events.
- Web check (`@ag-ui/core@0.0.41` on unpkg) confirms Activity event types we can emit:  
  - `ACTIVITY_SNAPSHOT` `{ type, messageId, activityType, content, replace? }`  
  - `ACTIVITY_DELTA` `{ type, messageId, activityType, patch }`
- PRD requires Activity/State to keep `/view/tasks/<taskId>` as the canonical task map and track pending interrupts for HITL decisions without leaking AG-UI-only identifiers to A2A.
- Goal: combine the minimal interrupt/resume flow (no frontend tools) with richer Activity/State projection for timeline and pending approvals.

## Decision

- **A2A HITL expression**: On pause, the agent sets `TaskState.input_required` and emits a status message containing a `TextPart` (user-facing explanation) plus a `DataPart { type: "a2a.hitl.form", formId, title, description?, fields[], metadata? }`. Resumption arrives as a follow-up message on the same `taskId` with `DataPart { type: "a2a.hitl.formResponse", formId, values, metadata? }`, which the agent validates before moving to `working` and then `succeeded`/`failed`.
- **AG-UI bridge behavior**: Maintain `{ threadId, runId } -> taskId` mapping. When `input_required` appears, stop streaming for the run, emit the final assistant `MESSAGE_CREATED` with the explanatory text, then emit `RUN_FINISHED` with `outcome: "interrupt"` and payload `{ taskId, contextId, interruptId, form }` where `interruptId = "hitl-<taskId>-<n>"` (per-task monotonic counter). To resume, the frontend opens a new run in the same `threadId` with `resume { interruptId, payload }`; the bridge sends `a2a.hitl.formResponse` to the original `taskId`, does not reopen the prior run, and continues normal streaming to completion.
- **Activity timeline**: On interrupt, emit `ACTIVITY_SNAPSHOT` with `activityType: "HITL_FORM"`, `messageId = interruptId`, and `content` carrying `stage: "awaiting_input"`, `taskId`, the form schema, and the explanation text. On resume or completion, emit `ACTIVITY_DELTA` JSON Patch updates for `stage` (`working` -> `completed`), `decision` (`provided`/`approved`/`rejected`), and optional summarized form values so the UI can render pending/approved/rejected approvals.
- **Shared state model**: Maintain `/view/tasks/<taskId>` as the canonical task map (status, lastRunId, lastInterruptId, summaries). Track pending interrupts under `/view/pendingInterrupts` as array/map entries `{ interruptId, taskId, formId, reason }`. Emit one `STATE_SNAPSHOT` on init and `STATE_DELTA` JSON Patch arrays as tasks and interrupts change (additions, updates, removals).
- **Replay and layering**: HITL prompts/responses stay in the A2A message timeline for audit; Activity/State emissions are AG-UI projections only. Keep AG-UI identifiers out of A2A payloads and continue streaming normal text/tool output until `input_required` ends the run with `outcome: "interrupt"`; the resumed run carries the remainder of the task.

## Consequences

- Clear interrupt/resume semantics: A2A owns truth; AG-UI presents via interrupt + Activity/State events.
- UI can show both chat bubble (assistant explanation) and “pending approvals” timeline without frontend-specific tools.
- Resumptions stay auditable (messages + Activity/State deltas) and keep task history intact; task map stays stable around a single canonical location.

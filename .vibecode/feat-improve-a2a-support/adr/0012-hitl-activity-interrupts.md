# ADR 0012: Input Interrupts via A2A `input_required` + AG-UI Activity/State

**Status**  
Accepted

**Date**  
2025-12-01

## Context

- We now need first-class input-required handling while keeping A2A the source of truth and AG-UI as a projection (ADR 0004, ADR 0006, ADR 0010).
- A2A expresses input pauses via `TaskState.input_required` and DataPart payloads; AG-UI surfaces pauses via interrupts/resume plus Activity/State events.
- Web check (`@ag-ui/core@0.0.41` on unpkg) confirms Activity event types we can emit:  
  - `ACTIVITY_SNAPSHOT` `{ type, messageId, activityType, content, replace? }`  
  - `ACTIVITY_DELTA` `{ type, messageId, activityType, patch }`
- PRD requires Activity/State to keep `/view/tasks/<taskId>` as the canonical task map and track pending interrupts for input-required decisions without leaking AG-UI-only identifiers to A2A.
- Goal: combine the minimal interrupt/resume flow (no frontend tools) with richer Activity/State projection for timeline and pending approvals.

## Decision

- **A2A input expression**: On pause, the agent sets `TaskState.input_required` and emits a status message containing a `TextPart` (user-facing explanation) plus a `DataPart { type: "a2a.input.request", requestId?, title?, description?, fields?, metadata? }`. Resumption arrives as a follow-up message on the same `taskId` with `DataPart { type: "a2a.input.response", requestId?, values, metadata? }`, which the agent validates before moving to `working` and then `succeeded`/`failed`.
- **AG-UI bridge behavior**: Maintain `{ threadId, runId } -> taskId` mapping. When `input_required` appears, stop streaming for the run, emit the final assistant `MESSAGE_CREATED` with the explanatory text, then emit `RUN_FINISHED` with `outcome: "interrupt"` and payload `{ taskId, contextId, interruptId, request }` where `interruptId = "input-<taskId>-<n>"` (per-task monotonic counter). To resume, the frontend opens a new run in the same `threadId` with `resume { interruptId, payload }`; the bridge sends `a2a.input.response` to the original `taskId`, does not reopen the prior run, and continues normal streaming to completion.
- **Activity timeline**: On interrupt, emit `ACTIVITY_SNAPSHOT` with `activityType: "INPUT_REQUEST"`, `messageId = interruptId`, and `content` carrying `stage: "awaiting_input"`, `taskId`, the request schema/payload, and the explanation text. On resume or completion, emit `ACTIVITY_DELTA` JSON Patch updates for `stage` (`working` -> `completed`), `decision` (`provided`/`approved`/`rejected`), and optional summarized input values so the UI can render pending/approved/rejected inputs.
- **Shared state model**: Maintain `/view/tasks/<taskId>` as the canonical task map (status, lastRunId, lastInterruptId, summaries). Track pending interrupts under `/view/pendingInterrupts` as array/map entries `{ interruptId, taskId, requestId, reason }`. Emit one `STATE_SNAPSHOT` on init and `STATE_DELTA` JSON Patch arrays as tasks and interrupts change (additions, updates, removals).
- **Replay and layering**: Input requests/responses stay in the A2A message timeline for audit; Activity/State emissions are AG-UI projections only. Keep AG-UI identifiers out of A2A payloads and continue streaming normal text/tool output until `input_required` ends the run with `outcome: "interrupt"`; the resumed run carries the remainder of the task.

## Consequences

- Clear interrupt/resume semantics: A2A owns truth; AG-UI presents via interrupt + Activity/State events.
- UI can show both chat bubble (assistant explanation) and “pending approvals” timeline without frontend-specific tools.
- Resumptions stay auditable (messages + Activity/State deltas) and keep task history intact; task map stays stable around a single canonical location.

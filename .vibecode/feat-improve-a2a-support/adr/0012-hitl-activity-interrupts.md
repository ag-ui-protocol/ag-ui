# ADR 0012: HITL Interrupts via A2A `input_required` + AG-UI Activity/State

**Status**  
Proposed

**Date**  
2025-12-01

## Context

- We now need first-class human-in-the-loop (HITL) handling while keeping A2A the source of truth and AG-UI as a projection (ADR 0004, ADR 0006, ADR 0010).
- A2A expresses HITL pauses via `TaskState.input_required` and DataPart payloads; AG-UI surfaces pauses via interrupts/resume plus Activity/State events.
- Web check (`@ag-ui/core@0.0.41` on unpkg) confirms Activity event types we can emit:  
  - `ACTIVITY_SNAPSHOT` `{ type, messageId, activityType, content, replace? }`  
  - `ACTIVITY_DELTA` `{ type, messageId, activityType, patch }`
- Goal: combine the minimal interrupt/resume flow (no frontend tools) with richer Activity/State projection for timeline and pending approvals.

## Decision

1) **A2A agent HITL contract**  
   - On HITL, set `TaskState.input_required` and return a status message whose parts include:  
     - `TextPart` with user-facing explanation.  
     - `DataPart` `{ type: "a2a.hitl.form", formId, title, description?, fields[], metadata? }` (form schema carried in `data`).  
   - When a follow-up A2A message arrives for the same `taskId` with `DataPart { type: "a2a.hitl.formResponse", formId, values, metadata? }`, validate, then resume task → `working` → `succeeded`/`failed`.

2) **AG-UI bridge: interrupt + resume backbone (variant a)**  
   - For each run: map `{ threadId, runId } -> { taskId }` (re-use task if provided, otherwise create). Forward AG-UI messages to A2A as TextParts/DataParts. Stream outputs as we do today.  
   - When A2A status is `input_required`:  
     - Stop further streaming for this run.  
     - Emit final `MESSAGE_CREATED` (assistant) with the explanatory text.  
     - Emit `RUN_FINISHED { outcome: "interrupt", interrupt: { taskId, contextId, form } }` using the form payload.  
   - Store optional bookkeeping (e.g., `tasksByRun[runId] = { a2aTaskId, interruptId, status: "input-required" }`) inside shared state if helpful for resume routing.
   - On resume: frontend issues a new run in same `threadId` with `resume { interruptId, payload }`; bridge sends A2A formResponse DataPart to the same `taskId`, then continues streaming to completion or failure.

3) **State model + deltas (variant b)**  
   - Represent HITL state in shared state with explicit maps (example):  
     ```json
     {
       "tasksById": {
         "<task-id>": {
           "status": "working" | "input-required" | "completed" | "failed",
           "lastRunId": "<run-id>",
           "lastInterruptId": "hitl-<task-id>-1",
           "summary": "<short description>"
         }
       },
       "pendingInterrupts": [
         {
           "interruptId": "hitl-<task-id>-1",
           "taskId": "<task-id>",
           "formId": "<form-id>",
           "reason": "input_required"
         }
       ]
     }
     ```
   - Emit a `STATE_SNAPSHOT` once per session/init; emit `STATE_DELTA` JSON Patch arrays as tasks and interrupts change. Use `/view/tasksById/...` and `/view/pendingInterrupts` (plural maps/arrays) to stay consistent with ADR 0010.

4) **Activity timeline (variant b)**  
   - On `input_required`, emit `ACTIVITY_SNAPSHOT` with `activityType: "HITL_FORM"` (or similar) and `content` including `stage: "awaiting_input"`, `taskId`, `form`. Use `messageId` stable per interrupt (`hitl-<task-id>-<n>`).  
   - When the user responds and the task resumes, emit `ACTIVITY_DELTA` patches updating `stage` (`completed`), `decision` (`approved` | `rejected` | `provided`), and any summarized form values.  
   - Keep Activity events additive to `STATE_DELTA` (timeline + state both available).

5) **Replay/audit guarantees**  
   - All HITL prompts/responses are A2A messages (ADR 0004); AG-UI Activity/State events are projections for UX.  
   - Do not encode AG-UI IDs (thread/run) into A2A metadata; keep mapping internal (ADR 0007).  
   - Continue to stream normal text/tool output; interruption just terminates the run with outcome `interrupt` and defers completion to a resumed run.

## Consequences

- Clear interrupt/resume semantics: A2A owns truth; AG-UI presents via interrupt + Activity/State events.
- UI can show both chat bubble (assistant explanation) and “pending approvals” timeline without frontend-specific tools.
- Resumptions stay auditable (messages + Activity/State deltas) and keep task history intact.

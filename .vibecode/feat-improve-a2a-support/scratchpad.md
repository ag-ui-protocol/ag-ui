# Troubleshooting: A2A ADR alignment gaps

Branch: feat/improve-a2a-support | Updated: 2025-12-02 15:10:00 UTC

## Current Focus

Working on: Final validation of ADR/PRD coverage; tests and build passes.
Approach: Verified A2A bridge behaviors via unit/int/e2e tests; ran workspace build; lint intentionally deferred per user request (missing eslint in @ag-ui/core).

## Evidence Collected

- A2A bridge now supports run/task mapping, subscribeOnly reconnect, Engram lane, full history/context forwarding, artifact/status projection, HITL interrupts/resume, and metadata hygiene; covered by unit/int/e2e tests.
- Workspace build passes (`pnpm build`). Lint still blocked by missing eslint in @ag-ui/core but intentionally deferred per user direction.
- Tests pass for @ag-ui/a2a (`pnpm --filter @ag-ui/a2a test`).

## Assumptions

- New design will require explicit RunOptions (`mode`, `taskId`) and Engram-aware message handling in the bridge.

## Attempts Log

2025-11-29 20:35:12 UTC Attempt 1: Reviewed ADRs 0001-0011 and current A2A TS integration (agent/utils/tests) → Collected discrepancies above.
2025-11-29 21:46:56 UTC Attempt 2: Planned implementation approach—introduce run options (`mode`, `taskId`, metadata gating), Engram extension (`urn:agui:engram:v1`), contextId mapping per thread (bridge-owned UUID), metadata forwarding of full history/context, and shared-state projection for status/artifact (default path `/view/artifacts/<artifactId>`, append-aware JSON Patch).
2025-11-29 22:03:48 UTC Attempt 3: Implemented run options + Engram handling + shared-state projection; added new conversion/state tests; builds succeeded via `pnpm build --filter @ag-ui/a2a...`; `pnpm --filter @ag-ui/a2a test` passing; `pnpm lint` still fails due to missing eslint dependency in workspace.
2025-12-01 18:47:00 UTC Attempt 4: Added ADR 0012 for HITL interrupts + Activity/State projection; updated PRD with HITL success criteria and activity/state requirements.
2025-12-02 00:21:07 UTC Attempt 5: Preparing to finalize ADR 0012 and PRD HITL sections with refined Activity/State/interrupt details (doc-only update).
2025-12-02 00:32:50 UTC Attempt 6: Adjusting ADR/PRD to keep `/view/tasks/<taskId>` as canonical task map and remove stray aggregates.
2025-12-02 00:36:18 UTC Attempt 7: Added cleanup plan to drop `/view/tasks/task-status` and `/view/tasks/task-audit` by deleting aggregates and updating bridge/tests accordingly.
2025-12-02 00:39:21 UTC Attempt 8: Captured remediation list (aggregate removal, forward full context/config/history, artifact/status projection, metadata layering, Engram lane wiring) for follow-up implementation.
2025-12-02 02:05:00 UTC Attempt 9: Implemented HITL interrupt handling and Activity/State projections per ADR 0012—input-required status now emits activity snapshots/deltas, pending interrupts under `/view/pendingInterrupts`, interrupt run-finish payloads, and monotonic `interruptId` generation; added resume payload conversion for formResponse; enforced shared-state snapshots/deltas with safe container creation and removal of legacy aggregates; updated tests (HITL flows, state projections, resume) now passing via `pnpm --filter @ag-ui/a2a test`; `pnpm build` passes; `pnpm lint` still fails workspace-wide due to missing `eslint` binary in @ag-ui/core.
2025-12-02 01:48:22 UTC Attempt 10: Implementing remaining PRD/ADR TODOs (forward full history/config/system/dev when opted in, Engram lane/config URN routing, metadata layering hygiene, removal of legacy `/view/tasks/*` aggregates, test decoupling from legacy paths).
2025-12-02 03:35:11 UTC Attempt 11: Completed aggregate removal + `taskAggregates` projection, message metadata forwarding (history/context/Engram), Engram header sanitization, and test updates; `pnpm --filter @ag-ui/a2a test` + `pnpm build` pass; `pnpm lint` still fails (eslint missing in @ag-ui/core).
2025-12-02 15:10:00 UTC Attempt 12: Marked ADRs/PRD Accepted; verified A2A tests (`pnpm --filter @ag-ui/a2a test`) and workspace build passing; lint intentionally deferred per user direction (missing eslint in @ag-ui/core).

## TODO (doc + implementation follow-up)

- [x] Remove legacy aggregate paths under `/view/tasks/*` (task-status/task-audit) and reserve `/view/tasks/<taskId>` as the canonical map; update bridge projections and tests accordingly.
- [x] Implement full AG-UI → A2A forwarding: include system/developer/config cues and full history/context when explicitly enabled; avoid latest-user-only payloads.
- [x] Implement A2A → AG-UI artifact/status projection per ADR 0010/0011: shared-state mapping (snapshots/appends), activity events, artifact metadata paths (now emits snapshots/deltas, pending interrupts, interrupt run-finish payloads).
- [x] Implement ADR 0012 HITL flow: handle `input-required` interrupts, emit activity/state events, pending interrupt tracking, interrupt `RUN_FINISHED` payloads, and resume via `a2a.hitl.formResponse`.
- [x] Wire Engram/config lane: support Engram URN, route config updates via Engram messages, remove legacy extension header.
- [x] Keep tests and source decoupled: test details must not leak into implementation—do not mirror test-only paths (e.g., legacy `/view/tasks/*` aggregates); update tests to reflect intentional source behavior.

## Discovered Patterns

- Shared-state projection (tasks/artifacts/pending interrupts) plus Engram lane gives consistent UI surface; need to keep default artifact base path stable (`/view/artifacts`) and avoid leaking thread/run IDs into A2A metadata.

## Blockers/Questions

- None; lint intentionally deferred (missing eslint in @ag-ui/core) per user.

## Resolution (when solved)

### Root Cause

Initial bridge was single-shot, text-only, reused UI identifiers, lacked config lane, artifact/status projection, and HITL handling—divergent from ADR 0001–0012.

### Solution

Implemented run/task mapping with reconnect, Engram/config lane, full history/context forwarding, artifact/status/shared-state projection, HITL interrupts/resume flows, metadata hygiene, and updated tests; build passes, lint deferred by choice.

### Learnings

Snapshot/delta projection plus metadata gating keeps UI/audit surfaces aligned while avoiding provenance leaks; Engram routing and HITL handling need explicit tests to prevent regressions.

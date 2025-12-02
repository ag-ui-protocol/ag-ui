# Troubleshooting: A2A ADR alignment gaps

Branch: feat/improve-a2a-support | Updated: 2025-12-01 19:05:00 UTC

## Current Focus

Working on: Implementing ADR 0012 HITL interrupt/resume in the A2A bridge, including Activity/State emissions and resume wiring, while keeping prior ADR gaps visible.
Approach: Design/plan bridge changes (input_required detection → interrupt/run-finished, Activity/State projections, resume via formResponse), then stage tests and lint/build once code changes land.

## Evidence Collected

- Run/Task mapping missing: `integrations/a2a/typescript/src/agent.ts` treats each `run` as one `sendMessage`/`sendMessageStream`, no long-lived subscription, no `taskId` reconnect/resubscribe or injection path (conflicts with ADR 0002/0003).
- Input canonicalization gaps: `createSendParams` only forwards latest user message with `acceptedOutputModes: ["text"]`; `convertAGUIMessagesToA2A` drops system/developer and config-like inputs, so canonical message history/config cues never reach A2A (ADR 0001/0004/0009).
- Output projection gaps: `convertA2AEventToAGUIEvents` ignores `TaskArtifactUpdateEvent` and turns non-message/status events into RAW fallback; no artifact/status projection to shared state (ADR 0009/0010/0011).
- Engram/config lane missing: bridge injects legacy extension header `https://a2ui.org/ext/a2a-ui/v0.1` but never emits/parses Engram URN or splits LLM vs config lanes; no config mutation path via messages (ADR 0005/0006/0008).
- Metadata layering risk: reuses AG-UI `threadId` as `contextId` and passes tool-call payloads as generic data without stable extension/metadata routing, so UI provenance can leak (ADR 0007).
- Workspace lint currently fails (`pnpm lint`) because `eslint` binary is not installed in scope (`@ag-ui/core` lint script cannot find eslint).
- ADR 0012 (HITL interrupts + Activity/State) added to codify input_required + form DataPart + interrupt/resume flow; PRD updated with HITL success criteria, Activity/State projections.

## Assumptions

- New design will require explicit RunOptions (`mode`, `taskId`) and Engram-aware message handling in the bridge.

## Attempts Log

2025-11-29 20:35:12 UTC Attempt 1: Reviewed ADRs 0001-0011 and current A2A TS integration (agent/utils/tests) → Collected discrepancies above.
2025-11-29 21:46:56 UTC Attempt 2: Planned implementation approach—introduce run options (`mode`, `taskId`, metadata gating), Engram extension (`urn:agui:engram:v1`), contextId mapping per thread (bridge-owned UUID), metadata forwarding of full history/context, and shared-state projection for status/artifact (default path `/view/artifacts/<artifactId>`, append-aware JSON Patch).
2025-11-29 22:03:48 UTC Attempt 3: Implemented run options + Engram handling + shared-state projection; added new conversion/state tests; builds succeeded via `pnpm build --filter @ag-ui/a2a...`; `pnpm --filter @ag-ui/a2a test` passing; `pnpm lint` still fails due to missing eslint dependency in workspace.
2025-12-01 18:47:00 UTC Attempt 4: Added ADR 0012 for HITL interrupts + Activity/State projection; updated PRD with HITL success criteria and activity/state requirements.

## Discovered Patterns

- Current bridge favors single-shot text-centric flows; lacks Task/artifact and config lanes emphasized in ADRs.

## Blockers/Questions

- None yet; next step is design/implementation plan to align bridge with ADRs.

## Resolution (when solved)

### Root Cause


### Solution


### Learnings

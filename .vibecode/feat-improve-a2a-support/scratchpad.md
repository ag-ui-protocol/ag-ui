# Troubleshooting: Improve A2A Support PRD

Branch: feat/improve-a2a-support | Updated: 2025-12-05

## Current Focus

Working on: Implementing Engram client integration per PRD at `.vibecode/feat-improve-a2a-support/prd.md`.
Approach: Implement Engram constructor-activated flows, forwardedProps engram modes, header handling, and supporting types/tests; lint/build/test.

## Evidence Collected

- Task is to implement the PRD file in `.vibecode/feat-improve-a2a-support/prd.md`.
- Branch `feat/improve-a2a-support` is checked out.
- Added Deliverables and Assumptions sections to PRD to clarify outputs and dependencies.
- Implemented Engram constructor flag enforcement, forwardedProps engram modes (hydrate_stream/hydrate_once/sync), sync helper, and Engram type definitions.
- Updated tests to require constructor-level Engram enablement; lint and build passing; jest run reports no tests found (package pattern).

## Assumptions

- Existing PRD draft is mostly complete; additions should be incremental and non-contradictory.
- Stakeholder expectations are captured in ADR 0014–0020; PRD should align with those references.

## Attempts Log

2025-12-05 Attempt 1: Added Deliverables and Assumptions/Dependencies sections to PRD → completed
2025-12-05 Attempt 2: Implemented Engram runtime changes (constructor-only activation, forwardedProps engram modes, sync/hydrate flows), added Engram types, updated engram-related tests; ran `pnpm --filter @ag-ui/a2a lint` (pass), `pnpm --filter @ag-ui/a2a build` (pass), `pnpm --filter @ag-ui/a2a test -- --runInBand` (jest found no tests) → completed
2025-12-05 Attempt 3: Investigated Jest invocation; direct `pnpm exec jest --runInBand` runs all 5 suites successfully (60 tests). Issue was the extra `--` in script call causing jest to treat `--runInBand` as a path pattern. → completed
2025-12-05 Attempt 4: Added PRD-aligned Engram mode tests (hydrate_stream, hydrate_once, sync, guardrails) to `engram.integration.test.ts`; fixed sync test CAS expectation; full suite now passes (64 tests). → completed
2025-12-05 Attempt 5: Added resume/sequence monotonicity, parallel stream presence, and patch-failure coverage; adjusted failing test expectations and reran full Jest suite (67 tests) → completed
2025-12-05 Attempt 6: Updated PRD to match behavior change (JSON Patch failure now emits RUN_ERROR and ends stream, no auto-rehydrate) → completed

## Discovered Patterns

- PRD already contained detailed overview, success criteria, and test plan; gaps were around explicit deliverables and dependencies.

## Blockers/Questions

- None so far.

## Resolution (when solved)

### Root Cause

### Solution

### Learnings

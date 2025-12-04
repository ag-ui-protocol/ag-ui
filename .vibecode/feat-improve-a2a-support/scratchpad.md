# A2A PR-Draft Blocking Issues (focused list)

Branch: feat/improve-a2a-support | Updated: 2025-12-03 23:22:56 UTC

## Current Focus
- Make the A2A bridge stateless per run (snapshot-seeded projection; deterministic interruptIds) and ensure threadId late-binds to the server contextId once per A2AAgent instance (caller creates a new agent to start a new context).
- Work in order: finalize stateless tracker + deterministic interruptIds, then implement explicit deferred-threadId mode (enabled by A2AAgent internally) and adjust subscriber/tests.

## Evidence Collected (since last update)
- Added unit test coverage to enforce contextId binding via `resolveThreadIdOnce` and to ensure deferred-threadId agents start with an empty threadId until the server binds it.
- Fixed `bindContextId` in A2A agent to use an arrow function so `this.resolveThreadIdOnce` is callable at runtime.
- Updated `AbstractAgent.prepareRunAgentInput` to avoid pre-generating threadId when `deferThreadId` is true.
- Full `pnpm build` now passes; `pnpm lint` still fails globally because `eslint` was not found on PATH.
- E2E harness fixed: test executor now always uses the shared event bus manager so artifact/status/interrupt events flow; @ag-ui/a2a test suite and lint for the package both pass.

## Evidence Collected
- Stateless tracker is in code: every run builds a fresh sharedStateTracker, seeds with `getTask` snapshot before stream/resubscribe, and uses deterministic `interruptId` (`input-${taskId}-${requestId||statusMessageId}`). Pending interrupts/state rebuilt per run.
- Late-binding exists: A2AAgent buffers events until a server `contextId` arrives, then sets `threadId/contextId`, emits RUN_STARTED, and flushes. Outbound first stream omits contextId when not provided. Tests cover this path.
- AbstractAgent contract is “threadId is per-instance”: once bound (caller-provided or first server contextId), the same threadId is reused for subsequent runs of that agent instance; callers must instantiate a new agent to start a new context. The current A2AAgent behavior (keep bound contextId across runs on the same instance) aligns with this.
- E2E harness bug: `createAgentExecutor` uses `bus.publish(...)` instead of the provided `eventBus`, so artifact/interrupt/status events aren’t emitted; matches failing e2e notes.
- Current bridge (post-interim fix) still starts with AG-UI-provided threadId; when no contextId is provided it omits one, then binds to the first server contextId and keeps it for the life of the agent instance (aligned with AbstractAgent per-instance threadId contract). Explicit “defer threadId” flag not yet added.
- Shared-state tracker is per-run; prior pendingInterrupts/interrupt counters reset on reconnect/resume, so deterministic interruptIds are needed to reconcile responses.
- Deterministic interruptId derivation from requestId/status messageId and snapshot-first projection ordering are implemented; getTask is called before streaming/resubscribe.
- A2A protocol requires server-generated `contextId`/`taskId`; the target refactor is to make threadId == server contextId (no cache) for A2A, while keeping AG-UI API unchanged.

## Assumptions
- A2A task snapshot + stream is the sole source of truth; bridge should be per-run stateless.
- Interrupt request payloads include stable identifiers (requestId or status messageId) to derive deterministic interruptIds.

## Stateless bridge plan (targets issue #2)
- Always call `getTask` before streaming/reconnect to seed projection; then `resubscribeTask`/`sendMessageStream` for deltas.
- Scope tracker to the run only; discard after stream ends—no cross-run persistence.
- Deterministic interruptIds from server data: `input-${taskId}-${requestId || statusMessageId}`; drop counters.
- Rebuild pendingInterrupts from snapshot/status; clear on `a2a.input.response` or non–input-required status during the same stream.
- Artifacts/status rely on snapshot + live deltas; no stored state required.

## Tests needed (validate stateless tracker & gaps)
- Reconnect with existing taskId: first event is STATE_SNAPSHOT from `getTask`; no prior-run data; pending interrupt reconstructed when status=input-required.
- Resume flow: new run sends `a2a.input.response`; pendingInterrupt removed with fresh tracker; interruptId matches snapshot-derived value.
- Artifact append→snapshot across reconnect: snapshot carries final value; stream append/deltas apply cleanly without duplicates using fresh tracker.
- Legacy text-only stream: when tracker is omitted, no STATE_DELTA events emitted.
- Client subscriber suite: snapshot-before-deltas on reconnect; RUN_FINISHED interrupt outcome still emitted.

## Tests needed (late-bound threadId/contextId)
1) First run, no contextId: initial send omits contextId; first snapshot/status yields contextId; RUN_STARTED emitted after binding; events carry threadId == contextId; outbound messages after binding include contextId.
2) Caller-provided contextId: RUN_STARTED not delayed; threadId equals provided contextId; outbound includes it; no late-binding path taken.
3) Resubscribe/stream with existing contextId: resubscribe RPC includes contextId; events use threadId == contextId; no UUIDs generated.
4) Error before contextId arrives: RUN_ERROR still emitted with either caller threadId or a provisional ID; no binding call.
5) Non-A2A agent regression: deferred threadId disabled, original timing/behavior unchanged.
6) Subscriber ordering: deferred agents still deliver RUN_STARTED before downstream events; no double RUN_STARTED; non-deferred unaffected.

## Next steps
- Add @ag-ui/client subscriber tests for reconnect/snapshot-first, interrupt outcome, artifact projection. ✅
- Execute and document checklist commands (pnpm --filter @ag-ui/a2a test ✅, pnpm --filter @ag-ui/client test ✅, pnpm build ✅).
- Implement explicit deferred-threadId mode: add `deferThreadId` opt-in to AbstractAgent; A2AAgent enables it in super() so the constructor doesn’t pre-generate threadId. Bind once to server contextId, then reuse per instance (no multi-context cache). Remove any local UUID generation for contextId.
- Implementation handoff:
  - Touch points: see “Proposed refactor” section for base-class and A2A agent changes.
  - Caller contract: threadId equals server contextId after first binding; callers keep using that threadId for this agent instance; create a new instance for a new context.***

## Attempts Log (relevant)
- 2025-12-03 00:10 UTC: Identified four gaps (contextId ordering, tracker lifecycle, missing client tests, unchecked checklist).
- 2025-12-03 00:25 UTC: Drafted stateless bridge plan and validation test list.
- 2025-12-03 01:07 UTC: Began implementation pass—reading A2A agent/utils and @ag-ui/client subscribers to plan stateless tracker + contextId ordering changes and tests.
- 2025-12-03 01:26 UTC: Implemented snapshot-seeded stateless tracker (deterministic interruptIds, getTask before streaming/resubscribe), reordered contextId resolution, and added A2A + client subscriber tests; ready to run suites/build.
- 2025-12-03 01:33 UTC: Ran @ag-ui/a2a tests, @ag-ui/client tests, and full pnpm build; lint skipped per instruction; build warnings only from existing Next.js hooks deps.
- 2025-12-03 21:05 UTC: Implemented interim contextId protocol fixes (omit generation; cache server-provided via onContextId; outbound metadata omits contextId unless provided). Tests pass; this will be replaced by late-bound threadId == server contextId (no cache) per refactor plan.
- 2025-12-03 23:41 UTC: Starting deferred-threadId binding + e2e event bus fix; tasks: add deferThreadId to AbstractAgent/A2AAgent, bind threadId once to server contextId, remove local context UUIDs, and correct test harness to publish via event bus before rerunning @ag-ui/a2a tests/build.
- 2025-12-03 23:45 UTC: Ran `pnpm --filter @ag-ui/a2a test` → failing with `resolveThreadIdOnce is not a function` (A2AAgent using stale @ag-ui/client build); need to rebuild client so runtime includes new helper, then rerun tests.

## Proposed refactor: threadId == server contextId for A2A, no bridge cache
- Goal: keep A2A stateless and server-owned IDs while avoiding A2A concepts in the public AG-UI API.
- Chosen approach: late-bind threadId to the first server contextId for A2A agents; no bridge cache; non-A2A agents unchanged.
- Code touch points:
  - `sdks/typescript/packages/client/src/agent/agent.ts`
    - Make threadId optional for agents that opt out (e.g., constructor flag `deferThreadId?: boolean`).
    - Add one-time `resolveThreadIdOnce(id: string)` that sets the instance threadId if not yet set.
    - Adjust RUN_STARTED emission: for deferred agents, allow RUN_STARTED to be emitted after threadId is resolved (still before downstream events). Non-deferred agents keep current timing.
  - `integrations/a2a/typescript/src/agent.ts`
    - When no caller contextId, omit contextId in the first A2A send.
    - Capture contextId from the first snapshot/status/message; call `resolveThreadIdOnce` with that value, then emit RUN_STARTED and subsequent events with the bound threadId == contextId.
    - Ensure all outbound A2A messages after binding include that contextId.
  - `integrations/a2a/typescript/src/utils.ts`
    - Ensure contextId from events is surfaced via `onContextId`; binding happens in the agent.
- Event semantics:
  - For deferred A2A agents, RUN_STARTED is delayed until contextId is received; after that, event order remains RUN_STARTED → snapshot/deltas/messages.
  - Non-A2A agents: no change.
  - Caller contract:
  - ThreadId and contextId are the same for A2A agents after the first binding; callers just keep using threadId. No extra contextId parameter is required in the public API.
- Tests to add/update:
  1) A2A unit: first run with no contextId emits RUN_STARTED after snapshot; threadId equals server contextId; outbound messages post-binding include contextId.
  2) A2A integration: resubscribe uses server contextId, no local UUID; RUN_STARTED timing validated.
  3) Subscriber tests: RUN_STARTED ordering for deferred agents; ensure no double emission.
  4) Error-before-contextId: verify RUN_ERROR still emitted with a temporary threadId or caller-supplied one.
  5) Non-A2A regression: existing behavior unchanged when `deferThreadId` is false/default.
- Rollout guardrails:
  - Keep default behavior for all agents; enable defer mode only in A2AAgent constructor.
  - Document the new optional behavior in ADR 0013 and a short README note for A2A.

## Discovered Patterns (relevant)
- Other integrations (LangGraph, Mastra) stay stateless: they rehydrate from backend state each run and emit STATE_SNAPSHOTs; projection is per-connection only.

---

## Progress Update (2025-12-03, later)
- Added client subscriber coverage for deferred RUN_STARTED ordering.
- Swapped e2e A2A tests to use the in-process @a2a-js/sdk server (DefaultRequestHandler, InMemoryTaskStore, DefaultExecutionEventBusManager, A2AExpressApp) instead of a hand-rolled stub.
- Current e2e status: tests failing; issues include missing event bus setup for artifact/interrupt tasks (see `bus.publish` typo in executor), lack of emitted artifact deltas/pending interrupts, and contextId binding mismatches when the server generates new IDs. Resubscribe paths warn about missing event bus; artifact/interrupt assertions fail due to no events.
- Next actions: fix test-side AgentExecutor to always publish via an event bus (createOrGetByTaskId) for all taskIds, emit artifacts/status/interrupt events so projections exist, and align assertions with server-generated contextIds. Re-run `pnpm --filter @ag-ui/a2a test` and build. Document any remaining source-behavior gaps if tests stay failing.

## Decision (2025-12-04)
- Do not widen `RunErrorEvent` schema to include `threadId`/`runId`. RUN_ERROR will remain message-only; A2A keeps emitting RUN_STARTED (with bound/provisional threadId) plus RUN_ERROR without thread/run fields. Changing this would require a cross-package schema update; we chose to defer.

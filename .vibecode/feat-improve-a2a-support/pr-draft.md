# Draft Pull Request: feat(a2a): add missing ag-ui bridge features

## Summary
Add the missing AG-UI coverage in the A2A bridge: run options with task-aware reconnects, config/control lane handling for AG-UI shared-state updates, shared-state/activity projection, and input-required interrupt/resume flows, while keeping existing text-only agent behavior intact.

## Changes
- Add run options (send/stream, taskId) plus:
  - `subscribe-only` to reconnect without sending a new message (fetch snapshot, then resubscribe, optional `historyLength`).
  - `resume` to send input responses to the existing task without reopening the prior run.
  - task-aware reconnect via snapshots/resubscribe.
  - accepted output modes, per-run includeSystem/includeDeveloper/includeTool toggles (control what reaches the A2A run), contextId auto-resolution (thread→task→generated) to decouple UI threadIds from A2A taskIds, default artifact base path.
- Add Engram update support: “Engram” is the new A2A extension for applying structured state/config updates to the A2A server (think durable memory trace). We inject Engram update payloads into outbound messages and only add the ENGRAM extension header when such data is present, aligning A2A state with AG-UI shared state (and other consumers) without blanket headers.
- When Engram is not present, the message rides the default LLM/conversational lane; any state/config changes would have to come from whatever tools the LLM chooses to invoke (if it has one), so Engram remains the explicit/only path for deterministic config mutation.
- Send the current payload with opt-in system/developer/config cues (no full transcript) using the dedicated config/control extension for shared state; drop the unused prior A2A extension in favor of Engram so structured state/config updates travel on the config lane without bundling full conversation history.
- Project A2A messages/status/artifacts into AG-UI text/tool/activity and shared-state events (snapshots + deltas), including:
  - Shared-state tracker emits initial snapshot then JSON Patch deltas (creates containers), supports append semantics for streaming artifact chunks (text/data/file) and metadata-path overrides so producers can place artifacts at meaningful paths.
  - HITL (human-in-the-loop): when A2A reports `input-required`, we surface a pending interrupt activity/state plus RUN_FINISHED outcome `interrupt`; when an input response (`a2a.input.response`) arrives, we remove the pending interrupt entry and patch the activity with provided values.
- Task resubscribe flow uses `getTask` snapshot (with optional historyLength) before `resubscribeTask` so reconnects start from a consistent latest state without replaying full history.
- Tests expanded across agent/utils/e2e and client subscriber suites to cover run modes, engram/config lane gating, shared-state projection, HITL interrupt/resume, artifact append, and task resubscribe.
- Implicit behaviors and defaults:
  - Run options default to `mode=stream`, `includeToolMessages=true`, `includeSystemMessages=false`, `includeDeveloperMessages=false`, `acceptedOutputModes=["text"]`, `artifactBasePath="/view/artifacts"`, `contextId` resolved thread→task→generated; `subscribeOnly` auto-enables when `mode=stream` + `taskId` is provided.
  - Stream failures fall back to blocking `send` only when streaming with a payload; `subscribeOnly` has no fallback path.
  - Resubscribe requires `taskId`; optional `historyLength` limits snapshot depth; snapshot is emitted before live deltas.
  - Shared-state: first emission per run is `STATE_SNAPSHOT`, then JSON Patch `STATE_DELTA`; containers auto-created; `append` controls concat/push/wrap, `lastChunk` closes artifact streaming.
  - Artifact paths: metadata `path` overrides default; otherwise use `artifactBasePath/artifactId`.
  - Interrupt IDs: monotonic per task (`input-<taskId>-N`); pending entries under `/view/pendingInterrupts`; events for non-target `taskId` are ignored when a task-scoped subscription is active.
  - Without Engram, messages stay on the LLM lane; any state/config change would require tools the LLM invokes—Engram remains the only deterministic config-mutation path.

## Architectural alignment
- ADR 0001 (Interface Surfaces): A2A is the single machine interface for agents/CLIs/jobs; AG-UI is the human/event surface; no bespoke REST/gRPC for cognition—REST stays infra/admin only.
- ADR 0002 (Run ↔ Task Mapping): One long-lived AG-UI Run subscribes to one long-lived A2A Task; mid-flight injections are short-lived control runs sending new messages to the same task; reconnects create a new Run that rehydrates via snapshots instead of reopening the old run.
- ADR 0003 (Run Modes): Run options map directly to A2A `message.send`/`message.stream`—`stream` creates/streams a task, `send` blocks/short-runs, existing `taskId` supports injections or secondary subscriptions; maintains backwards-compatible one-shot send while adding streaming.
- ADR 0004 (Canonical Input as Messages): Every behavior-affecting input is an A2A Message (parts/extensions/metadata); clients send only the current message (not full transcript); optional system/developer/config cues are opt-in; long-lived state lives in Tasks/Artifacts, not UI blobs.
- ADR 0005 (Engram Extension): Config/control changes travel via the Engram A2A extension (scoped task/context/agent), advertised in capabilities; Engram mutates callee config/state, Passport remains caller identity; config views surface back via Artifacts; Engram is optional and only used when explicit config changes are needed.
- ADR 0006 (Shared State as Projection): AG-UI shared state is a projection; config slice mirrors agent config via Engram deltas, view/data slice mirrors Task/Artifact outputs, UI-only stays local—agent behavior remains anchored to A2A state.
- ADR 0007 (Metadata Layering): Keep AG-UI-specific metadata internal to the bridge; external A2A payloads expose only protocol markers/extensions (e.g., Engram), not threadId/runId; routing inside the agent is done on semantic markers, not UI provenance.
- ADR 0008 (LLM vs Config Lanes): A2A has one message API; lane selection is via the Engram extension. Non-Engram messages stay on the LLM/conversational pipeline. Engram messages take the config lane, apply `agent_state_update` directly on A2A server/agent state, may emit derived system/context cues, and outputs still return via Tasks/Artifacts (Engram is input-only for config mutation).
- ADR 0009 (Audit & Replay): Canonical audit = A2A Message history + Task/Artifact lifecycle; all config changes must be Engram messages; domain/view changes flow via status/artifacts; other agents use the same Engram contract; text-only agents still work with default projection.
- ADR 0010 (Artifacts → Shared State): Tasks + Artifacts drive AG-UI projection; text artifacts stream as assistant messages (honor append/lastChunk), JSON/structured artifacts map to shared-state paths with snapshot/append semantics; artifacts are view projections, not config mutations (those remain Engram).
- ADR 0011 (Implicit vs Explicit Semantics): Provide safe implicit defaults for any agent (text/JSON artifacts to sensible paths with append/lastChunk); cooperative agents can provide metadata (kind/scope/path/uiKind) for precise projection; config stays explicit via Engram—artifacts never mutate config.
- ADR 0012 (Input Required / HITL): A2A signals pauses with `input_required` + `a2a.input.request` data parts; resume via `a2a.input.response`; bridge emits ACTIVITY_SNAPSHOT + STATE_SNAPSHOT/DELTA and RUN_FINISHED `outcome: "interrupt"` with monotonic `interruptId`; resume opens a new Run, sends the response to the same task, clears pending interrupts, and continues streaming.

## Testing
- [ ] `pnpm --filter @ag-ui/a2a test` (A2A agent/util e2e + integration Jest suites)
- [ ] `pnpm --filter @ag-ui/client test` (client agent/subscriber Jest suites)
- [ ] `pnpm build`
- [ ] Manual testing completed

## Related Issues
Closes #<issue-number>

## Notes
- pnpm; Node native env loading (no dotenv)

# deepagents Subagent Attribution Demo (Step 1) — Design

Status: Approved for implementation planning
Date: 2026-07-07
Scope: LangGraph Python integration (`ag_ui_langgraph`) emission + new dojo demo (Python agent + frontend). Builds on the AG-UI subagent protocol (`subagentId` on events/messages + `SUBAGENT_STARTED/FINISHED/ERROR`) added in `2026-07-07-subagent-support-design.md`.

## Goal

End-to-end proof that a **deepagents** subagent's messages surface to the dojo frontend carrying `subagentId`. Minimal UX — a small `subagentId` marker on attributed messages. This is **step 1**: prove the plumbing (deepagents → integration → AG-UI protocol → frontend message → visible marker), not a polished multi-agent UI.

## Non-Goals

- Polished/grouped subagent UI (collapsible cards, side panels, per-subagent timelines) — deferred to a later step.
- Retrofitting the existing `subgraphs` demo (it teaches a different, still-valid pattern — subgraph encapsulation + HITL + shared-state generative UI).
- Changing the subagent protocol itself (already shipped).
- Nested/recursive subagents (subagents that spawn subagents) beyond what deepagents does naturally; `parentSubagentId` is emitted if the data is available but is not a demo focus.

## Decisions (from brainstorming)

- **D1 — New demo, not a modification.** deepagents is the named mechanism and the integration already has deepagents-aware handling; the existing `subgraphs` demo stays intact.
- **D2 — Emit Phase 1 + Phase 2.** The integration emits `subagentId` on the subagent's creation events AND `SUBAGENT_STARTED/FINISHED/ERROR` lifecycle (name/description from the deepagents `subagent_type`).
- **D3 — Minimal frontend.** Just a small marker showing `subagentId` on messages that carry one. Step 1.
- **D4 — Three subagents.** The demo supervisor delegates to three specialized subagents.

## Feasibility hook (verified)

The integration already reads `event.metadata.langgraph_checkpoint_ns` (`agent.py:293`) but deliberately uses only the outermost namespace ("Only the outermost namespace matters here"). LangGraph nests `langgraph_checkpoint_ns` when a subgraph / deepagents `task`-subagent runs, so the nested namespace is the attribution signal. The frontend already consumes agents via `useAgent()` (`@copilotkit/react-core/v2`), exposing `agent.messages` whose objects now carry `subagentId` — the design doc's Phase 1 consumer path.

## Architecture

### Part A — Integration emission (`integrations/langgraph/python/ag_ui_langgraph`)

**A0. Spike (first task, before wiring).** Add `deepagents`, build a minimal agent with a `task`-delegated subagent, and capture the raw LangGraph event stream. Confirm empirically:
- A subagent's events carry a **nested** `langgraph_checkpoint_ns` distinct from the parent's.
- The subagent's entry/exit is detectable from namespace appearance/disappearance.
- Where the `subagent_type` (name) is available in event metadata for `SUBAGENT_STARTED`.

The spike's findings are recorded and drive A1–A3. If the surfacing differs from the nested-namespace assumption, the plan is revised before emission work.

**A1. Subagent detection + id derivation.** Maintain a per-run map of active subagent namespaces. When an event's nested `checkpoint_ns` first appears (depth > outermost), treat it as a new subagent invocation and derive a **stable, opaque `subagentId`** from that namespace segment (unique per invocation; the same namespace maps to the same id for the life of the invocation).

**A2. Lifecycle events (Phase 2).** On first sight of a subagent namespace, emit `SUBAGENT_STARTED` (`subagentId`, `name`/`description` from the `subagent_type`, `parentSubagentId` if the parent is itself a subagent). When the namespace's work completes, emit `SUBAGENT_FINISHED`; on error within it, `SUBAGENT_ERROR`. All opened subagents must be closed before `RUN_FINISHED` (matches the verifier's enforced-when-present rules).

**A3. Attribution (Phase 1).** Stamp `subagentId` on the **creation events** the integration emits while inside a subagent namespace — `TEXT_MESSAGE_START`/`TEXT_MESSAGE_CHUNK`, `TOOL_CALL_START`/`CHUNK`, `TOOL_CALL_RESULT`, `REASONING_*_START`, etc. — so the resulting messages carry it. Events outside any subagent namespace are unchanged (parent-owned).

Backwards-compat: for a normal (no-subagent) run, no nested namespace ever appears, so no `subagentId`/`SUBAGENT_*` is emitted and behavior is byte-identical to today.

### Part B — Python demo agent

New `integrations/langgraph/python/examples/agents/deepagents_subagents/agent.py`:
- Add `deepagents` as a dependency of the examples package.
- A supervisor `deep agent` with **three** specialized subagents (e.g. a research/planning scenario: three domain researchers the supervisor delegates sub-questions to via `task`). Simple and deterministic enough to reliably trigger all three delegations and produce subagent messages.
- Registered in the Python example registry alongside the other example agents.

### Part C — Frontend (dojo)

New page `apps/dojo/src/app/[integrationId]/feature/(v2)/deepagents-subagents/`:
- `page.tsx`: `useAgent()` → read `agent.messages`; for any message with `subagentId`, render a small inline marker/badge (e.g. `⟐ <subagentId>` or a short pill) next to/under the message. No grouping, no lifecycle UI for step 1.
- `README.mdx`: what it demonstrates (deepagents subagents + AG-UI subagent attribution, step 1).
- `style.css` as needed (minimal).

### Part D — Wiring

- Register the agent in the dojo config (`apps/dojo/src/agents.ts`, `config.ts`) and menu (`menu.ts`), following the `subgraphs` entry as the template.
- Ensure the integration serves the new example agent (example server registry).

## Testing

- **Integration (unit):** feed a simulated LangGraph event stream with a nested `checkpoint_ns` and assert: `SUBAGENT_STARTED` emitted once per subagent with the right name; `subagentId` stamped on the creation events within that namespace; `SUBAGENT_FINISHED` on namespace exit; all closed before `RUN_FINISHED`. Feed a non-nested stream and assert no subagent events/fields (backwards-compat).
- **Frontend:** light — render a message list containing a `subagentId` and assert the marker appears.
- **Spike output** is captured (a short note or fixture) so the tests use a realistic namespace shape.

## Flagged unknowns (resolved during the A0 spike)

- Exact deepagents event-surfacing shape (nested `checkpoint_ns` vs `task`-tool-only tagging).
- Clean detectability of the `SUBAGENT_FINISHED` boundary from namespace exit.
- Where `subagent_type` (→ `name`) is available in event metadata.
- Whether CopilotKit v2's `agent.messages` exposes `subagentId` verbatim (it should — the AG-UI message type now declares it), or whether a custom read of the raw stream is needed.

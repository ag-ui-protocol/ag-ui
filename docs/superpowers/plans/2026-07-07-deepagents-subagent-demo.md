# deepagents Subagent Attribution Demo (Step 1) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a deepagents `task`→subagent's work surface to the dojo frontend carrying `subagentId`, with `SUBAGENT_STARTED/FINISHED/ERROR` lifecycle emitted by the LangGraph Python integration. Minimal frontend (a small `subagentId` marker). Step 1: prove the plumbing end-to-end.

**Architecture:** Extend `ag_ui_langgraph` to detect subagent context from the nested `langgraph_checkpoint_ns` it already parses, emit lifecycle events at namespace transitions, and stamp `subagentId` on creation events at the single `_dispatch_event` chokepoint. Add a deepagents demo agent (3 subagents) and a minimal dojo page.

**Tech Stack:** Python (LangGraph, deepagents, unittest), TypeScript/React (`@copilotkit/react-core/v2`), the AG-UI subagent protocol (already shipped in `@ag-ui/core` / `ag_ui.core`).

Design spec: `docs/superpowers/specs/2026-07-07-deepagents-subagent-demo-design.md`.

## Global Constraints

- Builds on the shipped protocol: Python `SubagentStartedEvent`/`SubagentFinishedEvent`/`SubagentErrorEvent` and `subagent_id` on event/message classes already exist in `ag_ui.core`.
- **Backwards-compat is non-negotiable:** a normal (no-subagent) run has no nested namespace, so no `subagentId`/`SUBAGENT_*` may be emitted and behavior must be byte-identical to today. Every existing `ag_ui_langgraph` test must stay green.
- The existing `subgraphs` demo is untouched.
- `subagentId` is opaque and unique per subagent invocation; the same nested namespace maps to the same id for that invocation's lifetime.
- **This plan is spike-gated.** Task 1 confirms how deepagents events actually surface. Tasks 2–4 are written against the documented `checkpoint_ns` model (`node:uuid|inner:uuid`) the integration already uses; if Task 1's findings differ, revise Tasks 2–4 before implementing them (this is an explicit review checkpoint, not a placeholder).
- Python tests: `cd integrations/langgraph/python && python -m unittest <module>`.

## File Structure

**Integration (`integrations/langgraph/python/ag_ui_langgraph/`):**
- `agent.py` — subagent detection at the namespace-transition site (~L293–312); lifecycle emission; `subagentId` stamping in `_dispatch_event` (L174); subagent tracking fields in `active_run`.
- `types.py` — add subagent-tracking fields to the `RunMetadata` TypedDict.

**Demo agent:**
- `integrations/langgraph/python/examples/agents/deepagents_subagents/{__init__.py,agent.py}` (create) — deepagents supervisor + 3 subagents.
- example server + `pyproject.toml` (add `deepagents` dep + register the agent).

**Frontend (`apps/dojo/`):**
- `src/app/[integrationId]/feature/(v2)/deepagents-subagents/{page.tsx,README.mdx,style.css}` (create).
- `src/agents.ts`, `src/config.ts`, `src/menu.ts` — register the demo (mirror the `subgraphs` entries).

---

## Task 1: Spike — confirm how deepagents subagent events surface

**Files:**
- Create (throwaway, committed for reference): `integrations/langgraph/python/examples/agents/deepagents_subagents/spike_notes.md`

**Interfaces:**
- Produces: documented facts that Tasks 2–4 depend on — the `langgraph_checkpoint_ns` shape for a `task`-delegated subagent, where the `subagent_type`/name is available, and how the subagent's boundary (enter/exit) appears in the event stream.

- [ ] **Step 1: Add deepagents and build a minimal probe agent**

Add `deepagents` to `integrations/langgraph/python/pyproject.toml` deps and install (`poetry install` or `pip install deepagents`). Write a throwaway script that builds a `create_deep_agent`-style supervisor with ONE subagent and invokes it on a prompt that forces one `task` delegation.

- [ ] **Step 2: Capture the raw LangGraph event stream**

Run the probe with `graph.astream_events(..., version="v2")` (the same stream the integration consumes) and dump, for every event: `event["event"]`, `event["metadata"].get("langgraph_checkpoint_ns")`, `langgraph_node`, `run_id`, and any `subagent`/`task` identifiers in metadata or `data`.

- [ ] **Step 3: Record findings in `spike_notes.md`**

Answer concretely:
1. Does a subagent's events carry a **nested** `checkpoint_ns` (a `|`-separated segment beyond the root, or a `task:*` segment)? Paste 2–3 example `ns` strings.
2. What is the stable per-invocation identifier within that `ns` (which segment/uuid)?
3. Where is the subagent's **name/type** (`subagent_type`) available — event metadata, the `task` tool args, or the subagent node name?
4. How is subagent **exit** observable (namespace disappears / a specific end event)?
5. Confirm CopilotKit v2 `agent.messages` will carry `subagent_id` (the message class declares it; note if any serialization step drops it).

- [ ] **Step 4: Gate**

If findings match the `node:uuid|inner:uuid` nested-namespace model, proceed to Task 2 as written. If they differ (e.g. subagent work is tagged only by the `task` tool with no nested `ns`), STOP and revise Tasks 2–4's detection mechanism against the observed shape before continuing.

- [ ] **Step 5: Commit**

```bash
git add integrations/langgraph/python/examples/agents/deepagents_subagents/spike_notes.md integrations/langgraph/python/pyproject.toml
git commit -m "spike(langgraph): document deepagents subagent event surfacing"
```
End the body with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

---

## Task 2: Subagent tracking state + id/name derivation helper

**Files:**
- Modify: `integrations/langgraph/python/ag_ui_langgraph/types.py`
- Modify: `integrations/langgraph/python/ag_ui_langgraph/agent.py`
- Test: `integrations/langgraph/python/tests/test_subagent_emission.py` (create)

**Interfaces:**
- Produces: `RunMetadata` gains `active_subagents: dict[str, str]` (namespace → subagentId) and `current_subagent_id: Optional[str]`. A module-level helper `derive_subagent_context(ns: str, subgraphs) -> Optional[SubagentContext]` returning `{ subagent_id, name, parent_subagent_id }` or `None` when the event is not inside a subagent. Exact `ns` parsing per Task 1 findings; default model: a subagent is present when `ns` has a nested segment beyond the declared-subgraph root.

- [ ] **Step 1: Write the failing test**

Create `test_subagent_emission.py` with a helper-level test (no full graph needed):

```python
import unittest
from ag_ui_langgraph.agent import derive_subagent_context

class TestDeriveSubagentContext(unittest.TestCase):
    def test_no_subagent_for_empty_or_root_ns(self):
        self.assertIsNone(derive_subagent_context("", set()))
        self.assertIsNone(derive_subagent_context("agent:root-uuid", set()))

    def test_nested_ns_yields_stable_subagent_id(self):
        ns = "agent:root-uuid|researcher:sub-uuid-1"
        ctx1 = derive_subagent_context(ns, set())
        ctx2 = derive_subagent_context(ns, set())
        self.assertIsNotNone(ctx1)
        self.assertEqual(ctx1.subagent_id, ctx2.subagent_id)      # stable for same ns
        self.assertEqual(ctx1.name, "researcher")                  # name from the nested segment

    def test_distinct_nested_ns_yield_distinct_ids(self):
        a = derive_subagent_context("agent:root|researcher:sub-1", set())
        b = derive_subagent_context("agent:root|writer:sub-2", set())
        self.assertNotEqual(a.subagent_id, b.subagent_id)
```

(Adjust the exact `ns` literals to the shapes captured in `spike_notes.md`.)

- [ ] **Step 2: Run it — verify it fails**

Run: `cd integrations/langgraph/python && python -m unittest tests.test_subagent_emission`
Expected: FAIL — `derive_subagent_context` not defined.

- [ ] **Step 3: Add the tracking fields**

In `types.py`, add to the `RunMetadata` TypedDict: `active_subagents: Dict[str, str]` and `current_subagent_id: Optional[str]`. In `agent.py` `_handle_stream_events`, initialize them in `INITIAL_ACTIVE_RUN` (`"active_subagents": {}`, `"current_subagent_id": None`).

- [ ] **Step 4: Implement `derive_subagent_context`**

Add a module-level dataclass `SubagentContext(subagent_id: str, name: str, parent_subagent_id: Optional[str])` and function. Using the `ns` model (`root:uuid|seg:uuid|...`): the subagent is the deepest non-root segment; `name` is that segment's node-name portion; `subagent_id` is a deterministic function of the full nested `ns` (e.g. the nested segment's uuid, or a hash of the `ns` — stable per invocation); `parent_subagent_id` is the next-shallower nested segment's id if one exists, else `None`. Return `None` when `ns` has no nested segment beyond the root/declared-subgraph.

- [ ] **Step 5: Run it — verify it passes**

Run: `cd integrations/langgraph/python && python -m unittest tests.test_subagent_emission`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add integrations/langgraph/python/ag_ui_langgraph/types.py integrations/langgraph/python/ag_ui_langgraph/agent.py integrations/langgraph/python/tests/test_subagent_emission.py
git commit -m "feat(langgraph): derive subagent context from nested checkpoint_ns"
```
End the body with the Co-Authored-By line.

---

## Task 3: Emit SUBAGENT_STARTED/FINISHED/ERROR at namespace transitions

**Files:**
- Modify: `integrations/langgraph/python/ag_ui_langgraph/agent.py`
- Test: `integrations/langgraph/python/tests/test_subagent_emission.py` (extend)

**Interfaces:**
- Consumes: `derive_subagent_context` (Task 2), `active_run["active_subagents"]`/`["current_subagent_id"]`.
- Produces: within the per-event loop (alongside the existing `current_subgraph` transition at `agent.py:~305`), when the derived subagent context changes: emit `SubagentStartedEvent` on entering a not-yet-active subagent (record `ns→subagentId` in `active_subagents`, set `current_subagent_id`); emit `SubagentFinishedEvent` when leaving a subagent namespace (remove from `active_subagents`). On an upstream `error` event while a subagent is active, emit `SubagentErrorEvent` before/instead of the existing `RunErrorEvent` path. Before `RUN_FINISHED`, emit `SubagentFinishedEvent` for any still-open subagents.

- [ ] **Step 1: Write the failing test**

Extend `test_subagent_emission.py` with a stream-level test that drives `_handle_single_event`/the emission path (or a focused unit exercising the transition logic) over a synthetic sequence of events whose `metadata.langgraph_checkpoint_ns` goes root → nested(researcher) → root, and asserts the emitted event list contains `SUBAGENT_STARTED(name="researcher")` then `SUBAGENT_FINISHED` with the same `subagent_id`, and that a root-only sequence emits neither. Mirror the harness of the existing `tests/test_nested_tool_end_dedup.py` for constructing synthetic LangGraph events.

- [ ] **Step 2: Run it — verify it fails**

Run: `cd integrations/langgraph/python && python -m unittest tests.test_subagent_emission`
Expected: FAIL — no `SUBAGENT_*` events emitted.

- [ ] **Step 3: Implement the transition emission**

Import `SubagentStartedEvent`, `SubagentFinishedEvent`, `SubagentErrorEvent` from `ag_ui.core` (add to the existing `from ag_ui.core import (...)` block). At the namespace-derivation point (right after `ns = ...`/`current_subgraph` computation, ~L293–312), compute `subagent_ctx = derive_subagent_context(ns, self.subgraphs)` and reconcile against `active_run["active_subagents"]`:
- entering a new subagent (`ctx.subagent_id not in active_subagents`): `yield self._dispatch_event(SubagentStartedEvent(type=EventType.SUBAGENT_STARTED, subagent_id=ctx.subagent_id, name=ctx.name, parent_subagent_id=ctx.parent_subagent_id))`; record it; set `current_subagent_id`.
- a previously-active subagent no longer present in the current `ns` path: `yield self._dispatch_event(SubagentFinishedEvent(type=EventType.SUBAGENT_FINISHED, subagent_id=<id>))`; drop it; update `current_subagent_id` to the innermost still-active id or `None`.
In the existing `event["event"] == "error"` branch, if `current_subagent_id` is set, emit `SubagentErrorEvent(subagent_id=current_subagent_id, message=error_message)` (the run continues per the protocol — do not convert to `RUN_ERROR` for a subagent-scoped failure) — confirm against spike findings whether deepagents surfaces subagent errors distinctly. Before the `RUN_FINISHED` emission (in the finalization path, ~L483), drain `active_subagents` with `SubagentFinishedEvent`s.

- [ ] **Step 4: Run it — verify it passes**

Run: `cd integrations/langgraph/python && python -m unittest tests.test_subagent_emission`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add integrations/langgraph/python/ag_ui_langgraph/agent.py integrations/langgraph/python/tests/test_subagent_emission.py
git commit -m "feat(langgraph): emit SUBAGENT_STARTED/FINISHED/ERROR at subagent boundaries"
```
End the body with the Co-Authored-By line.

---

## Task 4: Stamp `subagentId` on creation events via `_dispatch_event`

**Files:**
- Modify: `integrations/langgraph/python/ag_ui_langgraph/agent.py`
- Test: `integrations/langgraph/python/tests/test_subagent_emission.py` (extend)

**Interfaces:**
- Consumes: `active_run["current_subagent_id"]` (Task 3).
- Produces: `_dispatch_event` stamps `subagent_id` on creation/standalone event instances that carry the field (`TEXT_MESSAGE_START/CHUNK`, `TOOL_CALL_START/CHUNK`, `TOOL_CALL_RESULT`, `REASONING_START`, `REASONING_MESSAGE_START`, `ACTIVITY_SNAPSHOT`, `STATE_SNAPSHOT/DELTA`, `STEP_STARTED/FINISHED`, `CUSTOM`, `RAW`) when a subagent is active and the event doesn't already carry one. Never stamps run-lifecycle or continuation events, nor `SUBAGENT_*` events themselves.

- [ ] **Step 1: Write the failing test**

Extend the test: drive a synthetic nested-namespace sequence that produces a `TEXT_MESSAGE_START` while inside the researcher subagent, and assert the emitted `TextMessageStartEvent.subagent_id == <researcher id>`; and that a `TEXT_MESSAGE_START` emitted at root has `subagent_id is None`. Also assert a continuation event (`TEXT_MESSAGE_CONTENT`) is NOT stamped.

- [ ] **Step 2: Run it — verify it fails**

Run: `cd integrations/langgraph/python && python -m unittest tests.test_subagent_emission`
Expected: FAIL — `subagent_id` is `None` on the in-subagent start event.

- [ ] **Step 3: Implement stamping in `_dispatch_event`**

Add a module-level constant set of the creation/standalone event types that carry `subagent_id` (mirror the protocol's classification). In `_dispatch_event`, before returning: if `self.active_run` and `self.active_run.get("current_subagent_id")` and `event.type in _SUBAGENT_ATTRIBUTABLE_EVENT_TYPES` and `getattr(event, "subagent_id", None) is None`, set `event.subagent_id = self.active_run["current_subagent_id"]`. Guard with `hasattr(event, "subagent_id")` so events lacking the field are untouched. Do NOT stamp `SUBAGENT_STARTED/FINISHED/ERROR` (exclude them from the set).

- [ ] **Step 4: Run it — verify it passes**

Run: `cd integrations/langgraph/python && python -m unittest tests.test_subagent_emission`
Expected: PASS.

- [ ] **Step 5: Full integration suite (backwards-compat gate)**

Run: `cd integrations/langgraph/python && python -m unittest discover tests`
Expected: ALL pass — a no-subagent run emits no `subagent_id`/`SUBAGENT_*` and every pre-existing test is unchanged.

- [ ] **Step 6: Commit**

```bash
git add integrations/langgraph/python/ag_ui_langgraph/agent.py integrations/langgraph/python/tests/test_subagent_emission.py
git commit -m "feat(langgraph): stamp subagentId on creation events while in a subagent"
```
End the body with the Co-Authored-By line.

---

## Task 5: deepagents demo agent (3 subagents)

**Files:**
- Create: `integrations/langgraph/python/examples/agents/deepagents_subagents/__init__.py`, `agent.py`
- Modify: the example server/registry that lists demo agents, and `pyproject.toml` (deepagents dep already added in Task 1).
- Test: none beyond a smoke import (the agent's behavior is exercised manually + by the frontend).

**Interfaces:**
- Produces: an importable graph/agent (matching how sibling examples like `subgraphs/agent.py` export theirs) that, on a user prompt, delegates to **three** specialized deepagents subagents via `task` and streams their messages.

- [ ] **Step 1: Read the sibling example + registry**

Read `examples/agents/subgraphs/agent.py` and the example server registry (how agents are named/exported/served) to match conventions exactly (export symbol, graph vs agent object, registration).

- [ ] **Step 2: Write the deepagents supervisor**

Create `agent.py`: a `create_deep_agent` supervisor with three subagents — e.g. a trip-planning scenario mirroring the repo's travel theme: `flights_researcher`, `hotels_researcher`, `experiences_researcher`, each a deepagents subagent the supervisor delegates a sub-question to via `task`. Keep prompts deterministic enough that a single user message reliably triggers all three delegations. Export it under the conventions from Step 1.

- [ ] **Step 3: Register + smoke test**

Register the agent in the example server. Verify it imports and constructs without error:
`cd integrations/langgraph/python && python -c "from examples.agents.deepagents_subagents.agent import <exported_symbol>; print('ok')"`
Expected: `ok`.

- [ ] **Step 4: Manual run — confirm attribution**

Run the example server and hit the agent (or use a short script calling the `LangGraphAgent` wrapper) with a prompt; confirm the emitted event stream contains `SUBAGENT_STARTED` for all three subagents and `subagent_id` on their messages. Capture one transcript snippet into `spike_notes.md` as evidence.

- [ ] **Step 5: Commit**

```bash
git add integrations/langgraph/python/examples/agents/deepagents_subagents/ <server/registry files> integrations/langgraph/python/pyproject.toml integrations/langgraph/python/examples/agents/deepagents_subagents/spike_notes.md
git commit -m "feat(langgraph-examples): add deepagents 3-subagent demo agent"
```
End the body with the Co-Authored-By line.

---

## Task 6: Minimal dojo frontend page

**Files:**
- Create: `apps/dojo/src/app/[integrationId]/feature/(v2)/deepagents-subagents/{page.tsx,README.mdx,style.css}`

**Interfaces:**
- Consumes: the AG-UI agent via `useAgent()` (`@copilotkit/react-core/v2`), reading `agent.messages` where each message may carry `subagentId`.
- Produces: a chat view that renders a small marker next to any message with a `subagentId`.

- [ ] **Step 1: Copy the subgraphs page skeleton**

Read `feature/(v2)/subgraphs/page.tsx` and create the new page mirroring its `CopilotKit` + `useAgent({...})` setup, pointed at `agentId="deepagents-subagents"`. Strip the subgraphs-specific state/interrupt UI down to a plain chat.

- [ ] **Step 2: Render the subagentId marker**

Where messages are rendered (or via a small custom message renderer / a pass over `agent.messages`), for any `message.subagentId` render a compact inline badge, e.g.:

```tsx
{message.subagentId ? (
  <span className="subagent-marker" title={`subagent ${message.subagentId}`}>
    ⟐ {message.subagentId.slice(0, 8)}
  </span>
) : null}
```

Add minimal `.subagent-marker` styling in `style.css`. If CopilotKit v2's default chat doesn't expose per-message custom fields in its renderer, read `agent.messages` directly (subscribe via the hook) and render a lightweight list beside the chat showing each message's role + `subagentId` marker. (Resolve which path per Task 1 finding #5.)

- [ ] **Step 3: README**

Write `README.mdx`: what it demonstrates (deepagents subagents + AG-UI `subagentId` attribution, step 1), noting the marker is intentionally minimal.

- [ ] **Step 4: Verify in-app**

Run the dojo, open the demo for the langgraph integration, send a prompt, and confirm subagent messages show the `subagentId` marker. (Use the `run` skill / dev server per repo convention.)

- [ ] **Step 5: Commit**

```bash
git add "apps/dojo/src/app/[integrationId]/feature/(v2)/deepagents-subagents/"
git commit -m "feat(dojo): minimal deepagents subagent-attribution demo page"
```
End the body with the Co-Authored-By line.

---

## Task 7: Wire the demo into dojo config + menu

**Files:**
- Modify: `apps/dojo/src/agents.ts`, `apps/dojo/src/config.ts`, `apps/dojo/src/menu.ts`

**Interfaces:**
- Produces: the demo registered so it appears in the langgraph integration's menu and routes to the new page, mirroring the `subgraphs` entries.

- [ ] **Step 1: Locate the subgraphs entries**

`grep -n "subgraphs" apps/dojo/src/agents.ts apps/dojo/src/config.ts apps/dojo/src/menu.ts` and read each hit to learn the exact registration shape (id, label, integration availability, agent mapping).

- [ ] **Step 2: Add the `deepagents-subagents` entries**

Add parallel entries (id `deepagents-subagents`, a label like "Deepagents Subagents", mapped to the new agent, enabled for the langgraph integration). Match the existing structure exactly.

- [ ] **Step 3: Verify build + menu**

Run: `cd apps/dojo && pnpm build` (or the repo's typecheck) — expect success. Confirm the entry appears in the menu when running the dojo.

- [ ] **Step 4: Commit**

```bash
git add apps/dojo/src/agents.ts apps/dojo/src/config.ts apps/dojo/src/menu.ts
git commit -m "feat(dojo): register deepagents-subagents demo in config and menu"
```
End the body with the Co-Authored-By line.

---

## Task 8: Verification

- [ ] **Step 1: Python integration suite + new tests**

Run: `cd integrations/langgraph/python && python -m unittest discover tests`
Expected: all pass, including `test_subagent_emission` and every pre-existing test (backwards-compat).

- [ ] **Step 2: Dojo build/typecheck**

Run: `cd apps/dojo && pnpm build`
Expected: success.

- [ ] **Step 3: End-to-end manual confirmation**

Run the langgraph example server + dojo, open the demo, send one prompt, and confirm: three `SUBAGENT_STARTED` events fire, subagent messages render with the `subagentId` marker, and the run completes cleanly (all subagents finished before `RUN_FINISHED`). Confirm an existing demo (e.g. `agentic_chat`) still works unchanged.

---

## Self-Review Notes

- **Spec coverage:** A0 spike → Task 1; A1 id derivation → Task 2; A2 lifecycle → Task 3; A3 attribution → Task 4; Part B agent (3 subagents) → Task 5; Part C frontend marker → Task 6; Part D wiring → Task 7; testing → per-task + Task 8.
- **Spike-gate:** Task 1 is a hard checkpoint; Tasks 2–4's namespace specifics are explicitly subject to its findings (called out, not left as placeholders — concrete code is given against the documented `checkpoint_ns` model the integration already uses).
- **Backwards-compat:** enforced at Task 4 Step 5 and Task 8 Step 1 (full pre-existing suite must stay green; no-subagent runs emit nothing new).
- **Chokepoint design:** attribution is stamped once in `_dispatch_event` rather than at every event-construction site — minimizes edits and centralizes the rule.
- **Consistency:** `subagent_id`/`SubagentStartedEvent` names match the shipped `ag_ui.core` Python API; `derive_subagent_context`/`SubagentContext` used consistently across Tasks 2–4.
- **Known soft spots:** exact `ns` parsing and `subagent_type`→name mapping (Task 1 resolves); whether the CopilotKit v2 default chat renderer exposes `subagentId` or requires reading `agent.messages` directly (Task 6 Step 2 handles both paths).

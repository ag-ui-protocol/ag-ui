# SPIKE — How a deepagents `task`→subagent surfaces in the LangGraph event stream

Task 1 (investigation) of the subagent-attribution plan for `ag_ui_langgraph`.
Findings gate the emission tasks. Do **not** implement from this file — it records evidence.

## Environment / install status

- **deepagents**: installed OK, version **0.6.12** (via `pip install deepagents`).
- Pulled in / required: **langchain 1.3.11**, **langchain-core 1.4.8**, **langgraph 1.2.8**.
- Note: deepagents 0.6.12 requires a newer `langchain` than the integration currently
  pins. The project's own `uv sync` env (langgraph 1.0.x / langchain 1.2.x) raises
  `ImportError: cannot import name 'InputAgentState' from langchain.agents.middleware.types`
  when importing deepagents. The probe therefore runs in an **isolated venv**
  (`scratchpad/spikeenv`, Python 3.12) with deepagents' resolved deps. This is a
  dependency-compatibility flag for later tasks, not a blocker for the spike.
- **No live LLM key used.** The probe uses deterministic `FakeMessagesListChatModel`
  subclasses (one for the supervisor, one for the researcher subagent). `OPENAI_API_KEY`
  is present in the env but is not touched.

## Probe

`spike_probe.py` builds a `create_deep_agent(...)` supervisor with ONE subagent
(`researcher`). The supervisor's fake model emits exactly one `task` tool call
(`subagent_type="researcher"`) then a final message; the researcher's fake model emits
one final message. Full per-event dump: run the probe (also writes `spike_trace.json`).

deepagents API used (v0.6.12):
```python
create_deep_agent(model=<supervisor model>, tools=[], system_prompt=..., subagents=[
    {"name": "researcher", "description": ..., "system_prompt": ..., "model": <sub model>, "tools": []},
])
```

### How the subagent is actually invoked (source, `deepagents/middleware/subagents.py`)

The `task` tool's coroutine calls the compiled subagent graph **directly from inside the
tool function**:
```python
subagent_config = {"configurable": {"ls_agent_type": "subagent"}}
result = await subagent.ainvoke(subagent_state, subagent_config)   # atask(); sync path uses .invoke()
```
It does **not** use a declared graph edge or `Send`. It relies on langgraph's
`ensure_config` seeding the child run from the ambient parent config — which is exactly
what makes `checkpoint_ns` nest (see below).

## The 5 questions — answered with real values from the run

Legend: root deepagent's own nodes carry a **single-segment** ns (`node:uuid`); the
outermost LangGraph wrapper events carry ns `None`/`""`.

### Q1 — Does the subagent carry a nested `checkpoint_ns`? (yes)

Real `langgraph_checkpoint_ns` strings from one run:

- Root / supervisor model event (idx 7–8, `on_chat_model_*`):
  `model:47d23e0b-a1ae-256b-b3df-a0ce080e20b8`
- **Subagent** model event (idx 22–26, inside researcher):
  `tools:e6df4457-a807-70f7-870b-bbf71e51498a|model:10f8993b-dfb0-606d-05f9-85cd0efb3237`
- Back-to-root model event after the subagent finishes (idx 35+):
  `model:74357164-6759-d12e-5551-65d82edd531f`

The subagent's events gain **one extra `|`-separated segment** prepended:
`tools:<uuid>|<inner-node>:<uuid>`. This matches the existing
`node:uuid|inner:uuid` model the integration already parses.

### Q2 — Stable per-invocation identifier

The **leading segment `tools:<uuid>`** — here `tools:e6df4457-a807-70f7-870b-bbf71e51498a` —
is constant across **every** event belonging to this one subagent invocation
(idx 18–30). It is the checkpoint_ns of the parent `tools` (ToolNode) task that is
running this specific `task(...)` tool call. Inner segments (`model:…`,
`PatchToolCallsMiddleware…`, `TodoListMiddleware…`) vary per inner node, so the
**first** segment is the invocation key.

- Use `ns.split("|")[0]` (== `"tools:e6df4457-…"`) as the per-invocation subagent id.
- `run_id` is **not** usable as the id — it is per-emitter (each node has its own), not
  per-invocation.
- Parallel `task` calls run as separate `__pregel_push` ToolNode tasks and therefore get
  distinct `tools:<uuid>` prefixes (not exercised here — single delegation — but that is
  how langgraph assigns push-task namespaces).

### Q3 — Where is the subagent name / type (`subagent_type`)?

Available in three places (most→least convenient):

1. **`event["metadata"]["lc_agent_name"]` == `"researcher"`** on every subagent event
   (idx 18–30) and `None` on every root event. This is the registered SubAgent `name`,
   which equals the `subagent_type`. Cleanest source.
2. The **`task` tool-call args**: at `on_chat_model_end` (idx 8) the AIMessage tool_call
   is `{"name": "task", "args": {"description": "...", "subagent_type": "researcher"}}`,
   and at `on_tool_start` (idx 17) `data.input == {"subagent_type": "researcher", ...}`.
3. The **subagent runnable's event `name`**: the boundary events `on_chain_start`
   (idx 18) and `on_chain_end` (idx 30) have `event["name"] == "researcher"`.

### Q4 — How is the subagent's exit observable?

Clear, ordered boundary at the end of the delegation:

- idx 30 `on_chain_end`, `name="researcher"`, ns `tools:e6df4457-…` (pipe gone),
  `lc_agent_name="researcher"` — the subagent graph closes.
- idx 31 `on_tool_end`, `name="task"`, ns `tools:e6df4457-…`, `lc_agent_name=None`
  — the `task` tool returns its ToolMessage to the supervisor.
- idx 35+ back to root: ns `model:74357164-…` (single segment), `lc_agent_name=None`.

So exit = the nested `|` ns (and `lc_agent_name`) stop appearing, bracketed by the
`on_chain_end name="researcher"` + `on_tool_end name="task"` pair. Entry is symmetric:
`on_tool_start name="task"` (idx 17) then `on_chain_start name="researcher"` (idx 18).

### Q5 — Nested LangGraph subgraph, or something else? (load-bearing)

**It runs as a nested LangGraph subgraph, and `checkpoint_ns` nests.** Even though the
subagent is launched by an explicit `await subagent.ainvoke(...)` inside the `task` tool
(not via a graph edge/`Send`), langgraph's ambient-config propagation makes the child
compiled graph inherit the parent `tools` node's checkpoint_ns and nest beneath it. The
subagent's internal events (chat-model start/end, middleware nodes) **fully surface in
the parent's `astream_events(version="v2")` stream** — they are not swallowed inside the
tool call. Confirmed: idx 18–30 all stream out with the `tools:<uuid>|…` ns.

## Verdict

**The plan's core assumption HOLDS.** A deepagents `task`-delegated subagent is
detectable via a nested `langgraph_checkpoint_ns`, and the nesting matches the existing
`node:uuid|inner:uuid` pipe-separated model the integration already parses at
`agent.py:293`.

Concrete shape to build the emission tasks around:

- **Detect "inside a subagent"**: the event's `langgraph_checkpoint_ns` contains a `|`
  (nesting depth deeper than the root deepagent's own single-segment node ns). Equivalent
  and more robust: `metadata.get("lc_agent_name")` is non-null (also flags the two
  subagraph-wrapper events at idx 18/30 whose ns has no pipe yet).
- **subagentId (stable per invocation)**: `ns.split("|")[0]` → e.g.
  `tools:e6df4457-a807-70f7-870b-bbf71e51498a`. Constant for the whole invocation.
- **subagent_type / name**: `metadata["lc_agent_name"]` (fallback: the `task` tool-call
  `args["subagent_type"]`).
- **Lifecycle boundaries**: enter on `on_tool_start name="task"` → `on_chain_start
  name=<subagent>`; exit on `on_chain_end name=<subagent>` → `on_tool_end name="task"`.

### Caveats for later tasks

1. **Two ns levels already exist at "root".** Unlike the model in the comment at
   `agent.py:295` (which implies root ns == `""`), a deepagent built via
   `create_deep_agent` gives its **own** top-level nodes single-segment ns
   (`model:uuid`, `tools:uuid`, `<Middleware>.<hook>:uuid`); only the outermost
   LangGraph wrapper events have ns `None`/`""`. So "root vs subagent" must key off the
   **presence of a `|`** (or `lc_agent_name`), not off ns being empty. The existing
   `ns_root in self.subgraphs` check will not fire for deepagents subagents (they are not
   declared subgraphs), so new detection logic is needed.
2. The leading segment prefix is literally `tools:<uuid>` because the ToolNode is named
   `tools`; do not assume a subagent-specific node name in the ns. The subagent identity
   lives in `lc_agent_name`, not in the ns segment name.
3. **Dependency compatibility**: deepagents 0.6.12 needs langchain ≥ ~1.3 /
   langchain-core ≥ ~1.4, newer than the integration's current pins. Bumping those (or
   validating the min versions that expose `InputAgentState`) is a prerequisite for
   running deepagents inside `ag_ui_langgraph` for real.

## Reproduce

```bash
# isolated env (project's own env is version-incompatible with deepagents 0.6.12)
uv venv --python 3.12 spikeenv
VIRTUAL_ENV=$PWD/spikeenv uv pip install deepagents langgraph
VIRTUAL_ENV=$PWD/spikeenv ./spikeenv/bin/python \
  integrations/langgraph/python/examples/agents/deepagents_subagents/spike_probe.py
```

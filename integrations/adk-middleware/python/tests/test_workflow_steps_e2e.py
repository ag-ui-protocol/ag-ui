#!/usr/bin/env python
"""End-to-end workflow-step tests over REAL ADK orchestrators (no LLM).

These drive the full ADKAgent producer/consumer with `emit_workflow_steps=True`
using real `SequentialAgent` / `ParallelAgent` / `LoopAgent` instances whose
leaves are trivial `BaseAgent`s (each yields text events authored by itself, no
model call). They verify the STEP_STARTED/STEP_FINISHED stream for every
topology, complementing the unit tests in test_workflow_steps.py.
"""

import asyncio

import pytest

from google.adk.agents import BaseAgent, SequentialAgent, ParallelAgent, LoopAgent
from google.adk.events import Event, EventActions
from google.genai import types
from ag_ui.core import RunAgentInput, UserMessage, EventType
from ag_ui_adk import ADKAgent

_STEP = (EventType.STEP_STARTED, EventType.STEP_FINISHED)


class SayAgent(BaseAgent):
    """Yields two text events authored by itself, sleeping between them so that
    concurrent branches (ParallelAgent) actually interleave."""

    async def _run_async_impl(self, ctx):
        yield Event(author=self.name,
                    content=types.Content(role="model", parts=[types.Part(text=f"{self.name}#1")]))
        await asyncio.sleep(0.01)
        yield Event(author=self.name,
                    content=types.Content(role="model", parts=[types.Part(text=f"{self.name}#2")]))


class StopAgent(BaseAgent):
    """Emits one event and escalates (terminates an enclosing LoopAgent)."""

    async def _run_async_impl(self, ctx):
        yield Event(author=self.name,
                    content=types.Content(role="model", parts=[types.Part(text=f"{self.name}#stop")]),
                    actions=EventActions(escalate=True))


class CustomFlow(BaseAgent):
    """An ADK *custom agent* (https://adk.dev/agents/custom-agents/): a BaseAgent
    that orchestrates its sub-agents with code-based control flow in
    `_run_async_impl`, instead of using SequentialAgent/ParallelAgent/LoopAgent."""

    def __init__(self, name, a, b, c):
        super().__init__(name=name, sub_agents=[a, b, c])

    async def _run_async_impl(self, ctx):
        async for e in self.sub_agents[0].run_async(ctx):
            yield e
        # code-based decision branching (this is the "dynamic" style done by hand)
        if True:
            async for e in self.sub_agents[1].run_async(ctx):
                yield e
        async for e in self.sub_agents[2].run_async(ctx):
            yield e


async def _run_steps(agent_obj, emit=True):
    """Run agent_obj through ADKAgent and return the (type, step_name) step list."""
    agent = ADKAgent(adk_agent=agent_obj, app_name="demo", user_id="u",
                     use_in_memory_services=True, emit_workflow_steps=emit)
    inp = RunAgentInput(thread_id="t", run_id="r", state={},
                        messages=[UserMessage(id="u1", role="user", content="go")],
                        tools=[], context=[], forwarded_props={})
    full = []
    async for ev in agent.run(inp):
        full.append((ev.type, getattr(ev, "step_name", None)))
    steps = [(t, n) for t, n in full if t in _STEP]
    return full, steps


def _well_formed(step_seq):
    """Each STEP_FINISHED matches the immediately-open STEP_STARTED; none left open."""
    open_name = None
    for t, n in step_seq:
        if t == EventType.STEP_STARTED:
            if open_name is not None:
                return False
            open_name = n
        else:
            if open_name != n:
                return False
            open_name = None
    return open_name is None


async def test_sequential_agent_emits_ordered_steps():
    full, steps = await _run_steps(
        SequentialAgent(name="seq", sub_agents=[SayAgent(name="a"), SayAgent(name="b"), SayAgent(name="c")])
    )
    assert steps == [
        (EventType.STEP_STARTED, "a"), (EventType.STEP_FINISHED, "a"),
        (EventType.STEP_STARTED, "b"), (EventType.STEP_FINISHED, "b"),
        (EventType.STEP_STARTED, "c"), (EventType.STEP_FINISHED, "c"),
    ]
    # Steps live inside the run brackets.
    assert full[0][0] == EventType.RUN_STARTED
    assert full[-1][0] == EventType.RUN_FINISHED


async def test_loop_agent_re_emits_steps_per_iteration():
    _full, steps = await _run_steps(
        LoopAgent(name="loop", max_iterations=2, sub_agents=[SayAgent(name="x"), SayAgent(name="y")])
    )
    assert [n for t, n in steps if t == EventType.STEP_STARTED] == ["x", "y", "x", "y"]
    assert _well_formed(steps)


async def test_loop_agent_escalate_stops_early():
    _full, steps = await _run_steps(
        LoopAgent(name="loop2", max_iterations=5, sub_agents=[SayAgent(name="w"), StopAgent(name="stopper")])
    )
    # One iteration only (stopper escalates); still well-formed.
    assert [n for t, n in steps if t == EventType.STEP_STARTED] == ["w", "stopper"]
    assert _well_formed(steps)


async def test_parallel_agent_steps_are_well_formed_best_effort():
    """ParallelAgent: concurrent branches interleave in the flat stream, so steps
    are best-effort — well-formed (each FINISHED matches its STARTED) and both
    branches appear, but they may open/close more than once. This test pins that
    documented contract rather than a strict order."""
    _full, steps = await _run_steps(
        ParallelAgent(name="par", sub_agents=[SayAgent(name="p"), SayAgent(name="q")])
    )
    assert steps, "parallel run should emit some steps"
    assert _well_formed(steps)
    assert {n for _t, n in steps} == {"p", "q"}


async def test_nested_sequential_of_parallel_then_agent():
    nested = SequentialAgent(name="root", sub_agents=[
        ParallelAgent(name="par", sub_agents=[SayAgent(name="p"), SayAgent(name="q")]),
        SayAgent(name="c"),
    ])
    _full, steps = await _run_steps(nested)
    assert _well_formed(steps)
    # The final sequential leaf closes last.
    assert steps[-2:] == [(EventType.STEP_STARTED, "c"), (EventType.STEP_FINISHED, "c")]


async def test_adk_2_0_workflow_graph_emits_steps():
    """ADK 2.0 Workflow graph engine: START -> wa -> wb emits a step per node."""
    try:
        from google.adk.workflow import Workflow, Edge, START, node
    except ImportError:
        pytest.skip("ADK 2.0 Workflow graph engine not available on this ADK version")

    wa = node(SayAgent(name="wa"))
    wb = node(SayAgent(name="wb"))
    wf = Workflow(name="graph", edges=[
        Edge(from_node=START, to_node=wa),
        Edge(from_node=wa, to_node=wb),
    ])
    _full, steps = await _run_steps(wf)
    assert steps == [
        (EventType.STEP_STARTED, "wa"), (EventType.STEP_FINISHED, "wa"),
        (EventType.STEP_STARTED, "wb"), (EventType.STEP_FINISHED, "wb"),
    ]


async def test_custom_agent_orchestrator_emits_steps():
    """ADK custom agent (code-based orchestration) emits one step per sub-agent."""
    flow = CustomFlow("custom_flow", SayAgent(name="alpha"), SayAgent(name="beta"), SayAgent(name="gamma"))
    _full, steps = await _run_steps(flow)
    assert steps == [
        (EventType.STEP_STARTED, "alpha"), (EventType.STEP_FINISHED, "alpha"),
        (EventType.STEP_STARTED, "beta"), (EventType.STEP_FINISHED, "beta"),
        (EventType.STEP_STARTED, "gamma"), (EventType.STEP_FINISHED, "gamma"),
    ]


async def test_single_agent_emits_no_steps():
    # A lone BaseAgent (no sub_agents) is not a workflow -> no steps even with flag on.
    _full, steps = await _run_steps(SayAgent(name="solo"))
    assert steps == []


async def test_flag_off_emits_no_steps_for_workflow():
    _full, steps = await _run_steps(
        SequentialAgent(name="seq", sub_agents=[SayAgent(name="a"), SayAgent(name="b")]),
        emit=False,
    )
    assert steps == []

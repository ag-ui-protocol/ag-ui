"""Concurrency-safety regression guard for AGUIToolset (ag-ui#1746 follow-up).

History: PR #1746 made ``ADKAgent`` attach the per-run ``ClientProxyToolset`` to
a single shared ``AGUIToolset`` instance via ``bind()`` (one mutable ``_delegate``
slot). Because ``_shallow_copy_agent_tree`` shares tool objects by reference and
``max_concurrent_executions`` defaults to 10, concurrent runs clobbered each
other's delegate — Run A's frontend tool calls could be routed to Run B's event
stream, and the first run's cleanup could strand an in-flight peer.

Fix: ``_update_agent_tools_recursive`` now *replaces* the placeholder with a
fresh per-run ``ClientProxyToolset`` in the per-run copy's ``tools`` list. Each
run gets its own toolset (its own ``input.tools`` + ``event_queue``); the
construction-time placeholder is never mutated. These tests assert that
isolation so the shared-state design can't return.
"""

from __future__ import annotations

import asyncio
from typing import Any, Callable, Dict, List
from unittest.mock import patch

from ag_ui.core import Tool, UserMessage
from ag_ui.core.types import RunAgentInput
from google.adk.agents import LlmAgent

from ag_ui_adk import ADKAgent
from ag_ui_adk.agui_toolset import AGUIToolset
from ag_ui_adk.client_proxy_toolset import ClientProxyToolset


def _make_input(thread_id: str, tool_name: str) -> RunAgentInput:
    """A minimal new-run input for ``thread_id`` exposing exactly one frontend tool."""
    return RunAgentInput(
        thread_id=thread_id,
        run_id=f"run_{thread_id}",
        messages=[UserMessage(id=f"m_{thread_id}", role="user", content="hi")],
        context=[],
        state={},
        tools=[
            Tool(
                name=tool_name,
                description=f"the {tool_name} tool",
                parameters={"type": "object", "properties": {}},
            )
        ],
        forwarded_props={},
    )


def _build_agent() -> tuple[ADKAgent, AGUIToolset]:
    """An ADKAgent whose root LlmAgent declares a single (unfiltered) AGUIToolset."""
    placeholder = AGUIToolset()  # no tool_filter -> every client tool passes through
    root = LlmAgent(name="root", instruction="be helpful", tools=[placeholder])
    agent = ADKAgent(
        adk_agent=root,
        app_name="concurrency_app",
        user_id="shared_user",
        use_in_memory_services=True,
    )
    return agent, placeholder


def _patch_background_noop() -> tuple[Any, List[Dict[str, Any]]]:
    """Patch ``_run_adk_in_background`` with an async no-op that records its kwargs."""
    captured: List[Dict[str, Any]] = []

    async def _noop(self, **kwargs):  # bound as a method -> receives self
        captured.append(kwargs)
        return None

    return patch.object(ADKAgent, "_run_adk_in_background", _noop), captured


async def _await_tasks(*execs) -> None:
    await asyncio.gather(*(e.task for e in execs), return_exceptions=True)


class TestAGUIToolsetConcurrencySafety:
    """Two concurrent runs must each get their own isolated frontend toolset."""

    async def test_concurrent_runs_get_isolated_proxy_toolsets(self) -> None:
        """Each run replaces the placeholder with its OWN ClientProxyToolset
        (its own tools + event_queue); the construction-time placeholder is
        never mutated and is not shared into either run's tools list."""
        agent, placeholder = _build_agent()
        bg_patch, captured = _patch_background_noop()

        with bg_patch:
            exec_a = await agent._start_background_execution(_make_input("thread-A", "toolA"))
            exec_b = await agent._start_background_execution(_make_input("thread-B", "toolB"))
            await _await_tasks(exec_a, exec_b)

        tree_a, tree_b = captured[0]["adk_agent"], captured[1]["adk_agent"]
        ts_a, ts_b = tree_a.tools[0], tree_b.tools[0]
        queue_a, queue_b = captured[0]["event_queue"], captured[1]["event_queue"]

        # Placeholder was REPLACED in each per-run copy, with distinct proxies.
        assert isinstance(ts_a, ClientProxyToolset) and isinstance(ts_b, ClientProxyToolset)
        assert ts_a is not ts_b, "concurrent runs must not share a ClientProxyToolset"

        # Construction-time placeholder untouched (not mutated, not in either run).
        assert agent._adk_agent.tools[0] is placeholder
        assert isinstance(agent._adk_agent.tools[0], AGUIToolset)

        # Each run resolves ITS OWN tools, on ITS OWN event stream.
        resolved_a = await ts_a.get_tools()
        resolved_b = await ts_b.get_tools()
        assert [t.name for t in resolved_a] == ["toolA"]
        assert [t.name for t in resolved_b] == ["toolB"]
        assert resolved_a[0].event_queue is queue_a
        assert resolved_b[0].event_queue is queue_b
        assert resolved_a[0].event_queue is not queue_b

    async def test_inflight_run_unaffected_by_other_runs_completion(self) -> None:
        """A run completing must not disturb a concurrent in-flight run's tools
        (the old ``finally`` unbind of the shared placeholder is gone)."""
        agent, _placeholder = _build_agent()
        bg_patch, captured = _patch_background_noop()

        with bg_patch:
            exec_a = await agent._start_background_execution(_make_input("thread-A", "toolA"))
            exec_b = await agent._start_background_execution(_make_input("thread-B", "toolB"))
            # Run A finishes; its (no-op) background task completes.
            await _await_tasks(exec_a)

            # Run B is still in flight and keeps its full tool list.
            ts_b = captured[1]["adk_agent"].tools[0]
            resolved_b = [t.name for t in await ts_b.get_tools()]
            assert resolved_b == ["toolB"], (
                f"in-flight Run B lost tools (got {resolved_b}) after Run A completed"
            )
            await _await_tasks(exec_b)

    async def test_real_concurrent_runs_each_resolve_their_own_tools(self) -> None:
        """Under genuine concurrent asyncio scheduling, each run's toolset (as a
        Runner would resolve it mid-flight) yields that run's own tools/stream."""
        agent, _placeholder = _build_agent()

        release = asyncio.Event()
        started: Dict[str, asyncio.Event] = {"thread-A": asyncio.Event(), "thread-B": asyncio.Event()}
        resolved: Dict[str, Dict[str, Any]] = {}

        async def runner_fake(self, *, input, adk_agent, event_queue, client_proxy_toolsets, **kwargs):
            label = input.thread_id
            started[label].set()
            await release.wait()  # park until both runs have set up
            tools = await adk_agent.tools[0].get_tools()  # what this run's Runner resolves
            resolved[label] = {
                "names": [t.name for t in tools],
                "own_queue": event_queue,
                "resolved_queue": tools[0].event_queue if tools else None,
            }

        async def _wait_until(pred: Callable[[], bool], timeout: float = 5.0) -> None:
            deadline = asyncio.get_event_loop().time() + timeout
            while not pred():
                if asyncio.get_event_loop().time() > deadline:
                    raise AssertionError("condition not met within timeout")
                await asyncio.sleep(0.005)

        with patch.object(ADKAgent, "_run_adk_in_background", runner_fake):
            exec_a = await agent._start_background_execution(_make_input("thread-A", "toolA"))
            await asyncio.wait_for(started["thread-A"].wait(), 5)
            exec_b = await agent._start_background_execution(_make_input("thread-B", "toolB"))
            await asyncio.wait_for(started["thread-B"].wait(), 5)
            release.set()
            await _wait_until(lambda: {"thread-A", "thread-B"} <= resolved.keys())
            await _await_tasks(exec_a, exec_b)

        assert resolved["thread-A"]["names"] == ["toolA"]
        assert resolved["thread-B"]["names"] == ["toolB"]
        assert resolved["thread-A"]["resolved_queue"] is resolved["thread-A"]["own_queue"]
        assert resolved["thread-B"]["resolved_queue"] is resolved["thread-B"]["own_queue"]
        assert resolved["thread-A"]["resolved_queue"] is not resolved["thread-B"]["own_queue"]

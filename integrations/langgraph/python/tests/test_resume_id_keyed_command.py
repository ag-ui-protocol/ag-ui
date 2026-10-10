"""Id-keyed resume Commands for LangGraph 1.x -- fixes #2178 and #2855.

LangGraph 1.x treats ``Command(resume=...)`` as a *keyed* resume only when
the value is a dict whose every key is a LangGraph interrupt id (a 32-char
xxh3-128 hexdigest -- ``langgraph/pregel/_loop.py`` checks
``all(is_xxh3_128_hexdigest(k) for k in resume)``). Anything else is a bare
resume value, and a bare value is rejected outright once more than one
interrupt is pending:

    RuntimeError: When there are multiple pending interrupts, you must
    specify the interrupt id when resuming.

A bare ``None`` is worse: ``resume_is_map`` is never bound on that path, so
LangGraph 1.2.8 raises ``UnboundLocalError`` and the interrupt stays open.

So both resume entry points -- the AG-UI standard ``RunAgentInput.resume[]``
and the legacy ``forwardedProps.command.resume`` -- have to emit the keyed
form whenever the ids are real LangGraph interrupt ids.
"""

import unittest
from dataclasses import dataclass, field
from typing import Any, List
from unittest.mock import AsyncMock, MagicMock

from ag_ui.core import ResumeEntry, UserMessage
from langchain_core.messages import AIMessage, HumanMessage
from langgraph.types import Command

from ag_ui_langgraph.interrupts import (
    DEFAULT_RESUME_SENTINEL_CANCELLED,
    DEFAULT_RESUME_SENTINEL_MAP,
)
from tests._helpers import make_agent


# Real LangGraph interrupt ids: 32 lowercase hex characters.
ID_A = "5b02c82efe18cad94db75c0f2d2d065c"
ID_B = "94ceda14649b123cf22f050f87185af5"
ID_C = "7a739ee06e46ce085b360d6d878f693d"


@dataclass
class FakeInterrupt:
    value: Any
    id: str = ID_A


@dataclass
class FakeTask:
    interrupts: List[FakeInterrupt] = field(default_factory=list)


def _make_state(messages, tasks=None):
    state = MagicMock()
    state.values = {"messages": messages}
    state.tasks = tasks or []
    state.next = []
    state.metadata = {"writes": {}}
    return state


def _make_input(messages, thread_id="t1", forwarded_props=None, resume=None):
    inp = MagicMock()
    inp.thread_id = thread_id
    inp.messages = messages
    inp.state = {}
    inp.tools = []
    inp.context = []
    inp.run_id = "run-1"
    inp.forwarded_props = forwarded_props or {}
    inp.resume = resume
    return inp


class TestAguiResumeBuildsIdKeyedCommand(unittest.TestCase):
    """``_build_command_from_agui_resume`` emits the keyed form (#2178)."""

    def test_single_resolved_entry_is_keyed_by_interrupt_id(self):
        agent = make_agent()
        entries = [ResumeEntry(interrupt_id=ID_A, status="resolved", payload={"approved": True})]

        cmd = agent._build_command_from_agui_resume(entries)

        self.assertIsInstance(cmd, Command)
        self.assertEqual(cmd.resume, {ID_A: {"approved": True}})

    def test_single_resolved_entry_with_none_payload_is_still_keyed(self):
        """``payload: None`` is a real answer. Bare ``resume=None`` is not a
        resume at all on LangGraph 1.x, so it must be carried in the map."""
        agent = make_agent()
        entries = [ResumeEntry(interrupt_id=ID_A, status="resolved", payload=None)]

        cmd = agent._build_command_from_agui_resume(entries)

        self.assertEqual(cmd.resume, {ID_A: None})

    def test_single_cancelled_entry_keeps_sentinel_under_its_id(self):
        agent = make_agent()
        entries = [ResumeEntry(interrupt_id=ID_A, status="cancelled", payload=None)]

        cmd = agent._build_command_from_agui_resume(entries)

        self.assertEqual(set(cmd.resume), {ID_A})
        self.assertTrue(cmd.resume[ID_A].get(DEFAULT_RESUME_SENTINEL_CANCELLED))
        self.assertEqual(cmd.resume[ID_A].get("interrupt_id"), ID_A)

    def test_partial_resume_sends_only_the_resolved_entry(self):
        """Several interrupts open, one answered: the map carries that one id
        and LangGraph leaves the rest pending."""
        agent = make_agent()
        open_interrupts = agent._interrupts_to_agui(
            [FakeInterrupt(value="a", id=ID_A), FakeInterrupt(value="b", id=ID_B)]
        )
        entries = [ResumeEntry(interrupt_id=ID_A, status="resolved", payload="x")]

        cmd = agent._build_command_from_agui_resume(entries, open_interrupts=open_interrupts)

        self.assertEqual(cmd.resume, {ID_A: "x"})

    def test_several_resolved_entries_all_land_under_their_own_ids(self):
        agent = make_agent()
        entries = [
            ResumeEntry(interrupt_id=ID_A, status="resolved", payload="x"),
            ResumeEntry(interrupt_id=ID_B, status="resolved", payload="y"),
        ]

        cmd = agent._build_command_from_agui_resume(entries)

        self.assertEqual(cmd.resume, {ID_A: "x", ID_B: "y"})
        self.assertNotIn(DEFAULT_RESUME_SENTINEL_MAP, cmd.resume)

    def test_mixed_resolved_and_cancelled_entries(self):
        agent = make_agent()
        entries = [
            ResumeEntry(interrupt_id=ID_A, status="resolved", payload={"a": 1}),
            ResumeEntry(interrupt_id=ID_B, status="cancelled", payload=None),
        ]

        cmd = agent._build_command_from_agui_resume(entries)

        self.assertEqual(cmd.resume[ID_A], {"a": 1})
        self.assertTrue(cmd.resume[ID_B].get(DEFAULT_RESUME_SENTINEL_CANCELLED))

    def test_every_key_is_a_langgraph_interrupt_id(self):
        """LangGraph only reads the dict as a keyed resume when every key is a
        32-char hexdigest, so no extra bookkeeping key may ride along."""
        from langgraph.pregel._utils import is_xxh3_128_hexdigest

        agent = make_agent()
        entries = [
            ResumeEntry(interrupt_id=ID_A, status="resolved", payload="x"),
            ResumeEntry(interrupt_id=ID_B, status="cancelled", payload=None),
        ]

        cmd = agent._build_command_from_agui_resume(entries)

        self.assertTrue(all(is_xxh3_128_hexdigest(k) for k in cmd.resume))

    def test_non_langgraph_ids_fall_back_to_the_bare_value(self):
        """An id LangGraph could not have minted would turn the dict into a
        bare value and silently hand the handler the wrapper, so the keyed
        form is only used when the ids are real."""
        agent = make_agent()
        entries = [ResumeEntry(interrupt_id="i1", status="resolved", payload={"approved": True})]

        cmd = agent._build_command_from_agui_resume(entries)

        self.assertEqual(cmd.resume, {"approved": True})


class TestLegacyCommandResumeIsKeyed(unittest.IsolatedAsyncioTestCase):
    """The legacy ``forwardedProps.command.resume`` channel (#2855)."""

    def _agent_and_state(self, interrupt_ids):
        agent = make_agent()
        agent.active_run = {"id": "run-1", "mode": "start"}
        checkpoint_messages = [
            HumanMessage(id="h1", content="do something"),
            AIMessage(
                id="ai1",
                content="",
                tool_calls=[{"id": "tc-1", "name": "approval", "args": {}}],
            ),
        ]
        state = _make_state(
            messages=checkpoint_messages,
            tasks=[
                FakeTask(
                    interrupts=[
                        FakeInterrupt(value={"question": "Approve?"}, id=i)
                        for i in interrupt_ids
                    ]
                )
            ],
        )
        agent.prepare_regenerate_stream = AsyncMock()
        return agent, state

    async def test_single_open_interrupt_is_keyed_by_its_id(self):
        agent, state = self._agent_and_state([ID_A])
        inp = _make_input(
            messages=[UserMessage(id="h1", role="user", content="do something")],
            forwarded_props={"command": {"resume": "yes"}},
        )

        await agent.prepare_stream(inp, state, {"configurable": {"thread_id": "t1"}})

        stream_input = agent.graph.astream_events.call_args.kwargs["input"]
        self.assertIsInstance(stream_input, Command)
        self.assertEqual(stream_input.resume, {ID_A: "yes"})

    async def test_several_open_interrupts_raise_a_clear_agui_error(self):
        """The legacy channel carries no interrupt id, so with several open it
        cannot pick one. Say that, instead of letting LangGraph's RuntimeError
        escape."""
        agent, state = self._agent_and_state([ID_A, ID_B])
        inp = _make_input(
            messages=[UserMessage(id="h1", role="user", content="do something")],
            forwarded_props={"command": {"resume": "yes"}},
        )

        with self.assertRaises(ValueError) as caught:
            await agent.prepare_stream(inp, state, {"configurable": {"thread_id": "t1"}})

        message = str(caught.exception)
        self.assertIn("resume", message)
        self.assertIn("interrupt", message)

    async def test_already_id_keyed_legacy_value_passes_through(self):
        """A caller already speaking LangGraph's own keyed format works today
        and must keep working."""
        agent, state = self._agent_and_state([ID_A, ID_B])
        inp = _make_input(
            messages=[UserMessage(id="h1", role="user", content="do something")],
            forwarded_props={"command": {"resume": {ID_A: "x", ID_B: "y"}}},
        )

        await agent.prepare_stream(inp, state, {"configurable": {"thread_id": "t1"}})

        stream_input = agent.graph.astream_events.call_args.kwargs["input"]
        self.assertEqual(stream_input.resume, {ID_A: "x", ID_B: "y"})


class TestAgainstRealLangGraph(unittest.TestCase):
    """The shapes above, run through a real graph on the locked LangGraph."""

    @staticmethod
    def _parallel_graph(thread_id):
        import operator
        from typing import Annotated, TypedDict

        from langgraph.checkpoint.memory import MemorySaver
        from langgraph.graph import START, StateGraph
        from langgraph.types import Send, interrupt

        class S(TypedDict):
            answers: Annotated[list, operator.add]

        builder = StateGraph(S)
        builder.add_node("ask", lambda q: {"answers": [interrupt(q)]})
        builder.add_conditional_edges(
            START, lambda s: [Send("ask", "a"), Send("ask", "b")], ["ask"]
        )
        graph = builder.compile(checkpointer=MemorySaver())
        config = {"configurable": {"thread_id": thread_id}}
        graph.invoke({"answers": []}, config)
        ids = [i.id for t in graph.get_state(config).tasks for i in t.interrupts]
        return graph, config, ids

    @staticmethod
    def _single_graph(thread_id):
        import operator
        from typing import Annotated, TypedDict

        from langgraph.checkpoint.memory import MemorySaver
        from langgraph.graph import START, StateGraph
        from langgraph.types import interrupt

        class S(TypedDict):
            answers: Annotated[list, operator.add]

        builder = StateGraph(S)
        builder.add_node("ask", lambda s: {"answers": [interrupt("q")]})
        builder.add_edge(START, "ask")
        graph = builder.compile(checkpointer=MemorySaver())
        config = {"configurable": {"thread_id": thread_id}}
        graph.invoke({"answers": []}, config)
        return graph, config, graph.get_state(config).tasks[0].interrupts[0].id

    def test_all_pending_resolved_round_trips(self):
        agent = make_agent()
        graph, config, ids = self._parallel_graph("agui-all")
        entries = [
            ResumeEntry(interrupt_id=ids[0], status="resolved", payload="x"),
            ResumeEntry(interrupt_id=ids[1], status="resolved", payload="y"),
        ]

        result = graph.invoke(agent._build_command_from_agui_resume(entries), config)

        self.assertEqual(sorted(result["answers"]), ["x", "y"])

    def test_partial_resume_leaves_the_other_interrupt_pending(self):
        agent = make_agent()
        graph, config, ids = self._parallel_graph("agui-partial")
        entries = [ResumeEntry(interrupt_id=ids[0], status="resolved", payload="x")]

        result = graph.invoke(agent._build_command_from_agui_resume(entries), config)

        self.assertEqual(result["answers"], ["x"])
        self.assertTrue(result.get("__interrupt__"))

    def test_none_payload_round_trips_as_none(self):
        agent = make_agent()
        graph, config, interrupt_id = self._single_graph("agui-none")
        entries = [ResumeEntry(interrupt_id=interrupt_id, status="resolved", payload=None)]

        result = graph.invoke(agent._build_command_from_agui_resume(entries), config)

        self.assertEqual(result["answers"], [None])


if __name__ == "__main__":
    unittest.main()

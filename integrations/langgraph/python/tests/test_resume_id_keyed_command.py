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


class TestLegacyResumeThroughRun(unittest.IsolatedAsyncioTestCase):
    """The legacy channel driven through ``LangGraphAgent.run`` on a real
    two-interrupt graph, so the open-interrupt count comes from LangGraph."""

    def _agent(self):
        import operator
        from typing import Annotated, TypedDict

        from langgraph.checkpoint.memory import MemorySaver
        from langgraph.graph import START, StateGraph
        from langgraph.graph.message import add_messages
        from langgraph.types import Send, interrupt

        from ag_ui_langgraph.agent import LangGraphAgent

        class S(TypedDict):
            messages: Annotated[list, add_messages]
            answers: Annotated[list, operator.add]

        builder = StateGraph(S)
        builder.add_node("ask", lambda q: {"answers": [interrupt(q)]})
        builder.add_conditional_edges(
            START, lambda s: [Send("ask", "a"), Send("ask", "b")], ["ask"]
        )
        graph = builder.compile(checkpointer=MemorySaver())
        return LangGraphAgent(name="asker", graph=graph), graph

    @staticmethod
    def _input(run_id, forwarded_props=None):
        from ag_ui.core import RunAgentInput

        return RunAgentInput(
            thread_id="legacy-run",
            run_id=run_id,
            state={},
            tools=[],
            context=[],
            forwarded_props=forwarded_props or {},
            messages=[UserMessage(id="h1", role="user", content="ask both")],
        )

    async def _run(self, agent, run_id, forwarded_props=None):
        return [e async for e in agent.run(self._input(run_id, forwarded_props))]

    @staticmethod
    def _terminal(events):
        from ag_ui.core import EventType

        return [
            e for e in events if e.type in (EventType.RUN_ERROR, EventType.RUN_FINISHED)
        ]

    async def _pending(self, graph):
        state = await graph.aget_state({"configurable": {"thread_id": "legacy-run"}})
        return {i.value: i.id for t in state.tasks for i in t.interrupts}

    async def test_bare_value_after_a_keyed_partial_answer_resumes_the_other(self):
        """Answer A by id, then send a bare value: only B is still open, so
        the bare value goes to B and the graph finishes."""
        from ag_ui.core import EventType

        agent, graph = self._agent()
        await self._run(agent, "r1")
        ids = await self._pending(graph)
        self.assertEqual(set(ids), {"a", "b"})

        await self._run(agent, "r2", {"command": {"resume": {ids["a"]: "A"}}})
        events = await self._run(agent, "r3", {"command": {"resume": "B"}})

        self.assertEqual(
            [e.type for e in self._terminal(events)], [EventType.RUN_FINISHED]
        )
        state = await graph.aget_state({"configurable": {"thread_id": "legacy-run"}})
        self.assertEqual(sorted(state.values["answers"]), ["A", "B"])
        self.assertFalse(state.tasks)

    async def test_open_interrupts_leaves_out_an_already_answered_one(self):
        """After a partial ``resume[]``, the hook that builds the next Command
        is told only about the interrupt still waiting for an answer."""
        agent, graph = self._agent()
        await self._run(agent, "r1")
        ids = await self._pending(graph)

        first = self._input("r2").model_copy(
            update={"resume": [ResumeEntry(interrupt_id=ids["a"], status="resolved", payload="A")]}
        )
        _ = [e async for e in agent.run(first)]

        seen = []
        build = agent._build_command_from_agui_resume

        def spy(entries, open_interrupts=None):
            seen.append([i.id for i in open_interrupts or []])
            return build(entries, open_interrupts=open_interrupts)

        agent._build_command_from_agui_resume = spy
        second = self._input("r3").model_copy(
            update={"resume": [ResumeEntry(interrupt_id=ids["b"], status="resolved", payload="B")]}
        )
        _ = [e async for e in agent.run(second)]

        self.assertEqual(seen, [[ids["b"]]])

    async def test_bare_value_with_two_open_interrupts_is_a_run_error(self):
        from ag_ui.core import EventType

        agent, graph = self._agent()
        await self._run(agent, "r1")

        events = await self._run(agent, "r2", {"command": {"resume": "yes"}})

        terminal = self._terminal(events)
        self.assertEqual([e.type for e in terminal], [EventType.RUN_ERROR])
        self.assertIn("2 interrupts are pending", terminal[0].message)
        self.assertEqual(len(await self._pending(graph)), 2)


class TestReInterruptedLanes(unittest.IsolatedAsyncioTestCase):
    """Resuming nodes that call ``interrupt()`` more than once, or that answer
    an interrupt and return nothing, driven end to end through ``run``.

    Once one of these tasks has been resumed, LangGraph reports its result as
    ``{}`` whether it finished or interrupted again, so the two cases look the
    same from outside. Keyed ``resume[]`` is always routed correctly. A bare
    legacy value is matched against the tasks that have no result yet.
    """

    def _agent(self, lanes):
        """``lanes`` maps a lane name to how its node behaves:

        - ``"twice"``: ``interrupt()`` twice, then record both answers.
        - ``"once"``: ``interrupt()`` once and record the answer.
        - ``"approval"``: ``interrupt()`` once and return ``None``. The answer
          only lands in ``self.approvals``.

        Recorded answers are tagged with their lane, e.g. ``"a:A1"``, so a
        test can see which interrupt each value reached.
        """
        import operator
        from typing import Annotated, TypedDict

        from langgraph.checkpoint.memory import MemorySaver
        from langgraph.graph import START, StateGraph
        from langgraph.graph.message import add_messages
        from langgraph.types import Send, interrupt

        from ag_ui_langgraph.agent import LangGraphAgent

        class S(TypedDict):
            messages: Annotated[list, add_messages]
            answers: Annotated[list, operator.add]

        self.approvals = []

        def ask(lane):
            kind = lanes[lane]
            if kind == "twice":
                first = interrupt(f"{lane}1")
                second = interrupt(f"{lane}2")
                return {"answers": [f"{lane}:{first}", f"{lane}:{second}"]}
            if kind == "approval":
                self.approvals.append(interrupt(lane))
                return None
            return {"answers": [f"{lane}:{interrupt(lane)}"]}

        builder = StateGraph(S)
        builder.add_node("ask", ask)
        builder.add_conditional_edges(
            START, lambda s: [Send("ask", lane) for lane in lanes], ["ask"]
        )
        graph = builder.compile(checkpointer=MemorySaver())
        return LangGraphAgent(name="asker", graph=graph), graph

    def _config(self):
        return {"configurable": {"thread_id": self.id()}}

    async def _run(self, agent, run_id, legacy=None, resume=None):
        from ag_ui.core import RunAgentInput

        run_input = RunAgentInput(
            thread_id=self.id(),
            run_id=run_id,
            state={},
            tools=[],
            context=[],
            forwarded_props={"command": {"resume": legacy}} if legacy is not None else {},
            messages=[UserMessage(id="h1", role="user", content="ask")],
            resume=resume,
        )
        return [e async for e in agent.run(run_input)]

    @staticmethod
    def _terminal(events):
        from ag_ui.core import EventType

        return [
            e.type
            for e in events
            if e.type in (EventType.RUN_ERROR, EventType.RUN_FINISHED)
        ]

    async def _pending(self, graph):
        state = await graph.aget_state(self._config())
        return {i.value: i.id for t in state.tasks for i in t.interrupts}

    async def _values(self, graph):
        return (await graph.aget_state(self._config())).values

    @staticmethod
    def _answer(interrupt_id, payload):
        return [ResumeEntry(interrupt_id=interrupt_id, status="resolved", payload=payload)]

    async def _answer_first_of_two(self, agent, graph):
        """Start the run and answer lane a's first interrupt by id."""
        await self._run(agent, "r1")
        ids = await self._pending(graph)
        await self._run(agent, "r2", resume=self._answer(ids["a1"], "A1"))
        return await self._pending(graph)

    async def test_single_node_second_interrupt_resumes_with_keyed_entry(self):
        from ag_ui.core import EventType

        agent, graph = self._agent({"a": "twice"})
        ids = await self._answer_first_of_two(agent, graph)
        self.assertEqual(set(ids), {"a2"})

        events = await self._run(agent, "r3", resume=self._answer(ids["a2"], "A2"))

        self.assertEqual(self._terminal(events), [EventType.RUN_FINISHED])
        self.assertEqual((await self._values(graph))["answers"], ["a:A1", "a:A2"])
        self.assertEqual(await self._pending(graph), {})

    async def test_single_node_second_interrupt_resumes_with_bare_legacy_value(self):
        from ag_ui.core import EventType

        agent, graph = self._agent({"a": "twice"})
        ids = await self._answer_first_of_two(agent, graph)
        self.assertEqual(set(ids), {"a2"})

        events = await self._run(agent, "r3", legacy="A2")

        self.assertEqual(self._terminal(events), [EventType.RUN_FINISHED])
        self.assertEqual((await self._values(graph))["answers"], ["a:A1", "a:A2"])
        self.assertEqual(await self._pending(graph), {})

    async def test_bare_legacy_value_reaches_the_lane_next_to_an_answered_approval(self):
        """Lane a is an approval step that returns nothing. Once it is
        answered by id, the bare legacy value belongs to lane b."""
        from ag_ui.core import EventType

        agent, graph = self._agent({"a": "approval", "b": "once"})
        await self._run(agent, "r1")
        ids = await self._pending(graph)
        self.assertEqual(set(ids), {"a", "b"})

        await self._run(agent, "r2", resume=self._answer(ids["a"], "approved"))
        events = await self._run(agent, "r3", legacy="B")

        self.assertEqual(self._terminal(events), [EventType.RUN_FINISHED])
        self.assertEqual((await self._values(graph))["answers"], ["b:B"])
        # LangGraph may run the approval node again on a later resume, so
        # only check which values it ever saw.
        self.assertEqual(set(self.approvals), {"approved"})
        self.assertEqual(await self._pending(graph), {})

    async def test_known_gap_bare_legacy_value_goes_to_the_parallel_lane(self):
        """Known limitation, documented in the README. Lane a has been
        answered once and is waiting on its second interrupt, lane b is
        still open. Lane a looks the same as a finished task, so a bare
        legacy value is keyed to lane b instead of being refused as
        ambiguous. If this starts failing because the run is refused or the
        value reaches lane a, the gap has been closed: update this test and
        the README note together."""
        from ag_ui.core import EventType

        agent, graph = self._agent({"a": "twice", "b": "once"})
        ids = await self._answer_first_of_two(agent, graph)
        self.assertEqual(set(ids), {"a2", "b"})

        events = await self._run(agent, "r3", legacy="X")
        self.assertEqual(self._terminal(events), [EventType.RUN_FINISHED])

        # Lane a is still waiting on its second interrupt; answering it by
        # id lets the run finish, and shows where "X" ended up.
        events = await self._run(agent, "r4", resume=self._answer(ids["a2"], "A2"))

        self.assertEqual(self._terminal(events), [EventType.RUN_FINISHED])
        self.assertEqual(
            sorted((await self._values(graph))["answers"]), ["a:A1", "a:A2", "b:X"]
        )
        self.assertEqual(await self._pending(graph), {})

    async def test_keyed_entries_route_correctly_when_a_lane_reinterrupts(self):
        """Same graph as the known gap above, answered with ``resume[]``:
        every answer reaches the interrupt it names."""
        from ag_ui.core import EventType

        agent, graph = self._agent({"a": "twice", "b": "once"})
        ids = await self._answer_first_of_two(agent, graph)
        self.assertEqual(set(ids), {"a2", "b"})

        events = await self._run(
            agent,
            "r3",
            resume=self._answer(ids["a2"], "A2") + self._answer(ids["b"], "B"),
        )

        self.assertEqual(self._terminal(events), [EventType.RUN_FINISHED])
        self.assertEqual(
            sorted((await self._values(graph))["answers"]), ["a:A1", "a:A2", "b:B"]
        )
        self.assertEqual(await self._pending(graph), {})

    async def test_keyed_entry_for_the_second_interrupt_leaves_the_parallel_lane_open(self):
        """Answering only lane a's second interrupt by id finishes lane a and
        leaves lane b waiting, rather than handing a's answer to b."""
        from ag_ui.core import EventType

        agent, graph = self._agent({"a": "twice", "b": "once"})
        ids = await self._answer_first_of_two(agent, graph)

        await self._run(agent, "r3", resume=self._answer(ids["a2"], "A2"))
        events = await self._run(agent, "r4", resume=self._answer(ids["b"], "B"))

        self.assertEqual(self._terminal(events), [EventType.RUN_FINISHED])
        self.assertEqual(
            sorted((await self._values(graph))["answers"]), ["a:A1", "a:A2", "b:B"]
        )
        self.assertEqual(await self._pending(graph), {})


if __name__ == "__main__":
    unittest.main()

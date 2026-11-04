"""TOOL_CALL_RESULT.messageId must equal the tool message id in MESSAGES_SNAPSHOT.

Regression: at ``on_tool_end`` the ToolMessage a tool returns usually has no
id; the adapter emits ``message_id = tool_call_id`` while LangGraph's
``add_messages`` assigns a fresh uuid4 when it stores the message. The
snapshot used to carry the tool message under that stored id, so the client's
id-based snapshot merge kept the streamed copy *and* appended the snapshot's
copy after the assistant's final text (assistant(tool_call) -> assistant(text)
-> tool), which was sent back on every later turn. The snapshot now presents
the stored tool message under the streamed id.

The integration tests run a real, minimal, fully offline graph (fake chat
model emitting one tool call, prebuilt ToolNode, MemorySaver) through the
adapter; the unit tests at the end drive the helpers directly.
"""
import asyncio
import unittest
from typing import Iterator, List

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, AIMessageChunk, HumanMessage, ToolMessage
from langchain_core.messages.tool import tool_call_chunk
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult
from langchain_core.tools import InjectedToolCallId, tool
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import START, MessagesState, StateGraph
from langgraph.prebuilt import ToolNode, tools_condition
from langgraph.types import Command
from typing_extensions import Annotated

from ag_ui.core import AssistantMessage, EventType, RunAgentInput, UserMessage
from ag_ui.core import ToolMessage as AguiToolMessage
from ag_ui_langgraph import LangGraphAgent


class _FakeToolCallingModel(BaseChatModel):
    """Calls ``get_weather`` once, then answers with text after the tool result."""

    counter: int = 0

    @property
    def _llm_type(self) -> str:
        return "fake-tool-calling"

    def bind_tools(self, tools, **kwargs):
        return self

    def _plan(self, messages):
        self.counter += 1
        if isinstance(messages[-1], ToolMessage):
            return "text", f"call_{self.counter}"
        return "tool", f"call_{self.counter}"

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        kind, call_id = self._plan(messages)
        if kind == "text":
            message = AIMessage(content="It is sunny.")
        else:
            message = AIMessage(
                content="",
                tool_calls=[{"name": "get_weather", "args": {"city": "Paris"},
                             "id": call_id, "type": "tool_call"}],
            )
        return ChatResult(generations=[ChatGeneration(message=message)])

    def _stream(self, messages, stop=None, run_manager=None, **kwargs) -> Iterator[ChatGenerationChunk]:
        kind, call_id = self._plan(messages)
        if kind == "text":
            chunks = [AIMessageChunk(content="It is "), AIMessageChunk(content="sunny.")]
        else:
            chunks = [
                AIMessageChunk(content="", tool_call_chunks=[
                    tool_call_chunk(name="get_weather", args="", id=call_id, index=0)]),
                AIMessageChunk(content="", tool_call_chunks=[
                    tool_call_chunk(name=None, args='{"city": "Paris"}', id=None, index=0)]),
            ]
        for chunk in chunks:
            generation = ChatGenerationChunk(message=chunk)
            if run_manager:
                run_manager.on_llm_new_token(chunk.content or "", chunk=generation)
            yield generation


@tool
def get_weather(city: str) -> str:
    """Get weather."""
    return f"Sunny in {city}"


@tool("get_weather")
def get_weather_command(city: str, tool_call_id: Annotated[str, InjectedToolCallId]) -> Command:
    """Get weather, returning a Command that carries a ToolMessage without an id."""
    return Command(update={"messages": [
        ToolMessage(content=f"Sunny in {city}", tool_call_id=tool_call_id)]})


@tool("get_weather")
def get_weather_command_dict(city: str, tool_call_id: Annotated[str, InjectedToolCallId]) -> Command:
    """Get weather, returning a Command whose message is a dict without an id."""
    return Command(update={"messages": [
        {"type": "tool", "content": f"Sunny in {city}", "tool_call_id": tool_call_id}]})


@tool("get_weather")
def get_weather_command_multi(city: str, tool_call_id: Annotated[str, InjectedToolCallId]) -> Command:
    """Get weather, returning a Command that carries several tool messages without ids.

    Besides its own result, the Command records a follow-up lookup the tool made
    (an assistant tool call plus its result), so one Command yields two
    TOOL_CALL_RESULT events.
    """
    inner_call_id = f"{tool_call_id}_forecast"
    return Command(update={"messages": [
        ToolMessage(content=f"Sunny in {city}", tool_call_id=tool_call_id),
        AIMessage(content="", tool_calls=[{"name": "get_forecast", "args": {"city": city},
                                           "id": inner_call_id, "type": "tool_call"}]),
        {"type": "tool", "content": f"Sunny all week in {city}",
         "tool_call_id": inner_call_id, "name": "get_forecast"},
    ]})


# One dict the tool keeps and returns on every call (a cached / module-level
# message). The adapter must not write an id into it: a stuck id would make
# add_messages treat the next call's result as a replacement of this one.
_REUSED_ENTRY: dict = {"type": "tool", "content": ""}


@tool("get_weather")
def get_weather_command_reused_dict(city: str,
                                    tool_call_id: Annotated[str, InjectedToolCallId]) -> Command:
    """Get weather, returning a Command that reuses one dict message across calls."""
    _REUSED_ENTRY.update({"content": f"Sunny in {city}", "tool_call_id": tool_call_id})
    return Command(update={"messages": [_REUSED_ENTRY]})


@tool
def lookup() -> str:
    """Inner lookup run by the subgraph."""
    return "inner result"


def _build_subgraph_calling_node():
    """A node that runs its own ToolNode subgraph for a tool call whose raw id
    repeats the root tool call's id. Its tool message has an id of its own and
    stays in the subgraph (the node returns nothing to root state)."""
    inner = StateGraph(MessagesState)
    inner.add_node("inner_tools", ToolNode([lookup]))
    inner.add_edge(START, "inner_tools")
    inner_graph = inner.compile()

    async def inner_node(state: MessagesState):
        call_id = state["messages"][-1].tool_call_id
        await inner_graph.ainvoke({"messages": [AIMessage(
            content="", id="inner-ai",
            tool_calls=[{"name": "lookup", "args": {}, "id": call_id, "type": "tool_call"}],
        )]})
        return {}

    return inner_node


def _build_graph(weather_tool, with_subgraph: bool = False):
    model = _FakeToolCallingModel()

    async def agent_node(state: MessagesState):
        return {"messages": [await model.ainvoke(state["messages"])]}

    graph = StateGraph(MessagesState)
    graph.add_node("agent", agent_node)
    graph.add_node("tools", ToolNode([weather_tool]))
    graph.add_edge(START, "agent")
    graph.add_conditional_edges("agent", tools_condition)
    if with_subgraph:
        graph.add_node("inner", _build_subgraph_calling_node())
        graph.add_edge("tools", "inner")
        graph.add_edge("inner", "agent")
    else:
        graph.add_edge("tools", "agent")
    return graph.compile(checkpointer=MemorySaver())


def _make_agent(weather_tool, emit_subagent_events: bool = False,
                with_subgraph: bool = False) -> LangGraphAgent:
    return LangGraphAgent(name="tool-result-id",
                          graph=_build_graph(weather_tool, with_subgraph),
                          emit_subagent_events=emit_subagent_events)


async def _stored_tool_ids(agent: LangGraphAgent) -> dict:
    state = await agent.graph.aget_state({"configurable": {"thread_id": "thread-1"}})
    return {m.tool_call_id: m.id for m in state.values["messages"] if isinstance(m, ToolMessage)}


async def _run(weather_tool, *, agent: LangGraphAgent = None, messages=None,
               run_id: str = "run-1", delay: float = 0.0) -> List:
    """Drain one run. ``delay`` > 0 makes the consumer slow (as an SSE write to
    a slow client is): the graph keeps running while each event is handled."""
    agent = agent or _make_agent(weather_tool)
    run_input = RunAgentInput(
        thread_id="thread-1", run_id=run_id, state={},
        messages=messages or [UserMessage(id="user-1", role="user", content="Weather in Paris?")],
        tools=[], context=[], forwarded_props={},
    )
    events = []
    async for event in agent.run(run_input):
        if isinstance(event, str):
            continue
        events.append(event)
        if delay:
            await asyncio.sleep(delay)
    return events


class TestToolCallResultMatchesSnapshot(unittest.IsolatedAsyncioTestCase):

    async def _assert_result_id_matches_snapshot(self, weather_tool, *, delay: float = 0.0,
                                                 emit_subagent_events: bool = False):
        agent = _make_agent(weather_tool, emit_subagent_events)
        events = await _run(weather_tool, agent=agent, delay=delay)
        results = [e for e in events if e.type == EventType.TOOL_CALL_RESULT]
        snapshots = [e for e in events if e.type == EventType.MESSAGES_SNAPSHOT]
        self.assertTrue(results, "expected a TOOL_CALL_RESULT")
        self.assertTrue(snapshots, "expected a MESSAGES_SNAPSHOT")

        snapshot_tools = {m.tool_call_id: m for m in snapshots[-1].messages if m.role == "tool"}
        self.assertEqual(len(snapshot_tools), len(results))
        stored_ids = await _stored_tool_ids(agent)
        for result in results:
            snapshot_tool = snapshot_tools[result.tool_call_id]
            self.assertEqual(result.message_id, snapshot_tool.id)
            # The tool message had no id: it streams under its tool_call_id,
            # while LangGraph stored it under a uuid of its own, so the
            # snapshot really is presenting the stored message under another id.
            self.assertEqual(result.message_id, result.tool_call_id)
            self.assertNotEqual(stored_ids[result.tool_call_id], result.message_id)

        # The snapshot keeps the order the client must send back:
        # user -> assistant(tool_call) -> tool(s) -> assistant(text).
        roles = [m.role for m in snapshots[-1].messages]
        self.assertEqual(roles[:3], ["user", "assistant", "tool"])
        self.assertEqual(roles[-1], "assistant")
        return agent, results, snapshots[-1]

    async def test_plain_tool(self):
        await self._assert_result_id_matches_snapshot(get_weather)

    async def test_tool_returning_command(self):
        await self._assert_result_id_matches_snapshot(get_weather_command)

    async def test_tool_returning_command_with_dict_message(self):
        await self._assert_result_id_matches_snapshot(get_weather_command_dict)

    async def test_tool_returning_command_with_several_messages(self):
        _, results, _ = await self._assert_result_id_matches_snapshot(get_weather_command_multi)
        self.assertEqual(len(results), 2)


class TestToolCallResultMatchesSnapshotWithSlowConsumer(unittest.IsolatedAsyncioTestCase):
    """The same contract when the consumer lags behind the graph.

    ``astream_events`` runs the graph in its own task and does not wait for the
    consumer, so by the time the adapter handles ``on_tool_end`` ToolNode may
    already have deep-copied a returned Command and LangGraph stored the copy
    under an id of its own. The streamed id must match the snapshot anyway, and
    the client sending the snapshot back must not duplicate tool messages.
    """

    DELAY = 0.02

    async def _assert_two_turns(self, weather_tool, emit_subagent_events: bool,
                                stored_differs: bool):
        agent = _make_agent(weather_tool, emit_subagent_events)
        events = await _run(weather_tool, agent=agent, delay=self.DELAY)
        results = [e for e in events if e.type == EventType.TOOL_CALL_RESULT]
        snapshot = [e for e in events if e.type == EventType.MESSAGES_SNAPSHOT][-1]
        snapshot_tools = {m.tool_call_id: m for m in snapshot.messages if m.role == "tool"}
        self.assertTrue(results)
        self.assertEqual(len(snapshot_tools), len(results))
        streamed = {r.tool_call_id: r.message_id for r in results}
        stored_ids = await _stored_tool_ids(agent)
        for call_id, message_id in streamed.items():
            self.assertEqual(snapshot_tools[call_id].id, message_id)
            if stored_differs:
                # The stored id differs from the streamed one, so this run went
                # through the presentation path rather than agreeing by accident.
                self.assertNotEqual(stored_ids[call_id], message_id)

        # Second turn: the client sends its history (the snapshot) back.
        second_input = [*snapshot.messages,
                        UserMessage(id="user-2", role="user", content="And tomorrow?")]
        events2 = await _run(weather_tool, agent=agent, messages=second_input,
                             run_id="run-2", delay=self.DELAY)
        snapshot2 = [e for e in events2 if e.type == EventType.MESSAGES_SNAPSHOT][-1]
        results2 = [e for e in events2 if e.type == EventType.TOOL_CALL_RESULT]

        # No tool message was duplicated in graph state.
        state = await agent.graph.aget_state({"configurable": {"thread_id": "thread-1"}})
        stored_tool_call_ids = [m.tool_call_id for m in state.values["messages"]
                                if isinstance(m, ToolMessage)]
        self.assertEqual(len(stored_tool_call_ids), len(set(stored_tool_call_ids)),
                         stored_tool_call_ids)
        self.assertEqual(len(stored_tool_call_ids), len(results) + len(results2))

        # Nor in the snapshot, and turn 1's tool messages keep the ids the
        # client already holds; turn 2's match their streamed results too.
        snapshot2_tools = [m for m in snapshot2.messages if m.role == "tool"]
        self.assertEqual(len(snapshot2_tools), len({m.tool_call_id for m in snapshot2_tools}))
        snapshot2_ids = {m.tool_call_id: m.id for m in snapshot2_tools}
        streamed.update({r.tool_call_id: r.message_id for r in results2})
        self.assertEqual(snapshot2_ids, streamed)

    async def _assert_both_modes(self, weather_tool, stored_differs: bool = True):
        for emit_subagent_events in (False, True):
            with self.subTest(emit_subagent_events=emit_subagent_events):
                await self._assert_two_turns(weather_tool, emit_subagent_events, stored_differs)

    async def test_plain_tool(self):
        # add_messages fills the id of the very ToolMessage the tool returned,
        # in place; a lagging consumer may already see that id at on_tool_end,
        # so the streamed and stored ids can agree here by themselves.
        await self._assert_both_modes(get_weather, stored_differs=False)

    async def test_tool_returning_command(self):
        await self._assert_both_modes(get_weather_command)

    async def test_tool_returning_command_with_dict_message(self):
        await self._assert_both_modes(get_weather_command_dict)

    async def test_tool_returning_command_with_several_messages(self):
        await self._assert_both_modes(get_weather_command_multi)


class TestToolObjectsAreNotMutated(unittest.IsolatedAsyncioTestCase):

    async def test_tool_reusing_its_message_dict_keeps_every_result(self):
        """A tool that returns the same dict on every call keeps one stored
        result per call: no id is written into the dict, so add_messages never
        sees a later call's result as a replacement of an earlier one."""
        agent = _make_agent(get_weather_command_reused_dict)
        events = await _run(get_weather_command_reused_dict, agent=agent)
        self.assertNotIn("id", _REUSED_ENTRY)
        snapshot = [e for e in events if e.type == EventType.MESSAGES_SNAPSHOT][-1]
        await _run(get_weather_command_reused_dict, agent=agent, run_id="run-2", messages=[
            *snapshot.messages, UserMessage(id="user-2", role="user", content="And tomorrow?")])
        self.assertNotIn("id", _REUSED_ENTRY)
        stored = await _stored_tool_ids(agent)
        self.assertEqual(len(stored), 2, stored)
        self.assertEqual(len(set(stored.values())), 2, stored)


class TestRepeatedToolCallIdAcrossSubgraph(unittest.IsolatedAsyncioTestCase):

    async def test_subgraph_tool_result_does_not_rename_root_tool_message(self):
        """A subgraph tool result that reuses the root tool call's raw id must
        not change the id the root tool message is presented under, with
        subagent events on or off."""
        for emit_subagent_events in (False, True):
            with self.subTest(emit_subagent_events=emit_subagent_events):
                agent = _make_agent(get_weather, emit_subagent_events, with_subgraph=True)
                events = await _run(get_weather, agent=agent)
                results = [e for e in events if e.type == EventType.TOOL_CALL_RESULT]
                # Root result first, then the subgraph's, same raw tool_call_id.
                self.assertEqual(len(results), 2, results)
                self.assertEqual(results[0].tool_call_id, results[1].tool_call_id)
                root_result = results[0]
                self.assertEqual(root_result.content, "Sunny in Paris")
                snapshot = [e for e in events if e.type == EventType.MESSAGES_SNAPSHOT][-1]
                root_tools = [m for m in snapshot.messages
                              if m.role == "tool" and m.content == "Sunny in Paris"]
                self.assertEqual(len(root_tools), 1)
                self.assertEqual(root_tools[0].id, root_result.message_id)


def _helper_agent(ids_by_call=None) -> LangGraphAgent:
    agent = LangGraphAgent(name="helpers", graph=_build_graph(get_weather))
    agent.active_run = {
        "id": "run-1",
        "tool_message_ids_by_call": dict(ids_by_call or {}),
        "current_subagent_run_id": None,
        "schema_keys": {"input": ["messages", "tools"], "output": ["messages", "tools"],
                        "config": [], "context": []},
    }
    return agent


def _merge_input() -> RunAgentInput:
    return RunAgentInput(thread_id="t1", run_id="r1", state={}, messages=[], tools=[],
                         context=[], forwarded_props={})


def _checkpoint(content: str = "Sunny in Paris"):
    return [
        HumanMessage(id="user-1", content="Weather in Paris?"),
        AIMessage(id="ai-1", content="", tool_calls=[
            {"name": "get_weather", "args": {"city": "Paris"}, "id": "call_1", "type": "tool_call"}]),
        ToolMessage(id="stored-uuid", content=content, tool_call_id="call_1"),
        AIMessage(id="ai-2", content="It is sunny."),
    ]


class TestPresentStreamedToolMessageIds(unittest.TestCase):

    def _snapshot(self):
        return [
            UserMessage(id="user-1", role="user", content="Weather in Paris?"),
            AguiToolMessage(id="stored-uuid", role="tool", content="Sunny", tool_call_id="call_1"),
            AguiToolMessage(id="stored-2", role="tool", content="Rain", tool_call_id="call_2"),
        ]

    def test_presents_stored_message_under_streamed_id(self):
        agent = _helper_agent({"call_1": "call_1"})
        snapshot = self._snapshot()
        presented = agent._present_streamed_tool_message_ids(snapshot)
        self.assertEqual([m.id for m in presented], ["user-1", "call_1", "stored-2"])
        # Copied, not mutated.
        self.assertEqual(snapshot[1].id, "stored-uuid")

    def test_never_takes_an_id_another_message_uses(self):
        agent = _helper_agent({"call_1": "stored-2"})
        presented = agent._present_streamed_tool_message_ids(self._snapshot())
        self.assertEqual([m.id for m in presented], ["user-1", "stored-uuid", "stored-2"])

    def test_no_mapping_leaves_snapshot_unchanged(self):
        agent = _helper_agent()
        snapshot = self._snapshot()
        self.assertIs(agent._present_streamed_tool_message_ids(snapshot), snapshot)


class TestRecordStreamedToolMessageId(unittest.TestCase):

    def _event(self, ns):
        return {"metadata": {"langgraph_checkpoint_ns": ns}}

    def test_records_root_namespace(self):
        agent = _helper_agent()
        agent._record_streamed_tool_message_id(self._event("tools:1"), "call_1", "m1")
        self.assertEqual(agent.active_run["tool_message_ids_by_call"], {"call_1": "m1"})

    def test_skips_nested_namespace(self):
        agent = _helper_agent({"call_1": "m1"})
        agent._record_streamed_tool_message_id(self._event("inner:2|inner_tools:3"), "call_1", "m2")
        self.assertEqual(agent.active_run["tool_message_ids_by_call"], {"call_1": "m1"})

    def test_skips_inside_subagent_even_with_events_off(self):
        agent = _helper_agent({"call_1": "m1"})
        self.assertFalse(agent.emit_subagent_events)
        agent.active_run["current_subagent_run_id"] = "tools:sub"
        agent._record_streamed_tool_message_id(self._event("tools:sub"), "call_1", "m2")
        self.assertEqual(agent.active_run["tool_message_ids_by_call"], {"call_1": "m1"})


class TestSeedToolMessageIdsFromInput(unittest.TestCase):

    def test_seeds_echo_under_another_id(self):
        agent = _helper_agent()
        agent._seed_tool_message_ids_from_input(
            [ToolMessage(id="call_1", content="Sunny in Paris", tool_call_id="call_1")],
            _checkpoint(),
        )
        self.assertEqual(agent.active_run["tool_message_ids_by_call"], {"call_1": "call_1"})

    def test_ignores_stored_id_and_different_result(self):
        agent = _helper_agent()
        agent._seed_tool_message_ids_from_input(
            [ToolMessage(id="stored-uuid", content="Sunny in Paris", tool_call_id="call_1"),
             ToolMessage(id="client-real", content="Real result", tool_call_id="call_1"),
             ToolMessage(id="call_9", content="Unanswered", tool_call_id="call_9")],
            _checkpoint(),
        )
        self.assertEqual(agent.active_run["tool_message_ids_by_call"], {})


class TestMergeStateDropsOnlyEchoes(unittest.TestCase):

    def _merge(self, agent, checkpoint, inbound):
        merged = agent.langgraph_default_merge_state({"messages": checkpoint}, inbound, _merge_input())
        return [m for m in merged["messages"] if isinstance(m, ToolMessage)]

    def test_drops_echo_under_presented_id(self):
        agent = _helper_agent({"call_1": "call_1"})
        # Content differs only in shape (content blocks), the id is the alias.
        echo = ToolMessage(id="call_1", tool_call_id="call_1",
                           content=[{"type": "text", "text": "Sunny in Paris (edited)"}])
        self.assertEqual(self._merge(agent, _checkpoint(), [echo]), [])

    def test_drops_echo_with_same_content(self):
        agent = _helper_agent()
        echo = ToolMessage(id="client-copy", content="Sunny in Paris", tool_call_id="call_1")
        self.assertEqual(self._merge(agent, _checkpoint(), [echo]), [])

    def test_keeps_different_result_for_answered_call(self):
        """deepagents-style: the checkpoint holds a "cancelled" placeholder and
        the client sends the real result under its own id. Kept, as on main."""
        agent = _helper_agent()
        checkpoint = _checkpoint("Tool call get_weather with id call_1 was cancelled - "
                                 "another message came in before it could be completed.")
        real = ToolMessage(id="client-real", content="Sunny in Paris", tool_call_id="call_1")
        kept = self._merge(agent, checkpoint, [real])
        self.assertEqual([m.id for m in kept], ["client-real"])


if __name__ == "__main__":
    unittest.main()

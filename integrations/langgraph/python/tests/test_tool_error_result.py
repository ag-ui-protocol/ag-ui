"""A failed tool call streams TOOL_CALL_RESULT, just like a successful one (#3196).

When a tool raises and ToolNode turns the exception into an error ToolMessage,
LangGraph fires ``on_tool_error`` and never ``on_tool_end``. The adapter only
emitted TOOL_CALL_RESULT from ``on_tool_end``, so the failed call's result
reached the client only in the final MESSAGES_SNAPSHOT. It now streams from the
ToolNode's ``on_chain_end``, carrying the message ToolNode actually produced.

The tests run a real, fully offline graph through the adapter: the fake chat
model from test_tool_result_snapshot_id, the prebuilt ToolNode and MemorySaver.
"""
import unittest
from typing import List

from langchain_core.messages import AIMessage, ToolMessage
from langchain_core.tools import tool
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, MessagesState, StateGraph
from langgraph.prebuilt import ToolNode, tools_condition
from langgraph.types import Command, interrupt

from ag_ui.core import EventType, RunAgentInput, UserMessage
from ag_ui_langgraph import LangGraphAgent
from tests.test_tool_result_snapshot_id import _FakeToolCallingModel


@tool
def get_weather(city: str) -> str:
    """Get weather."""
    raise RuntimeError("service unavailable")


@tool("get_weather")
def get_weather_by_zip(zip_code: int) -> str:
    """Get weather. The fake model passes ``city``, so the call fails validation."""
    return f"Sunny in {zip_code}"


@tool("get_weather")
def get_weather_ok(city: str) -> str:
    """Get weather."""
    return f"Sunny in {city}"


class _SameCallIdModel(_FakeToolCallingModel):
    """Like _FakeToolCallingModel, but its tool call has the id ``call_1`` on every turn."""

    def _plan(self, messages):
        kind, _ = super()._plan(messages)
        return kind, "call_1"


async def _error_to_command(request, execute):
    """An awrap_tool_call error handler that returns the error as a Command."""
    try:
        return await execute(request)
    except RuntimeError as exc:
        return Command(update={"messages": [ToolMessage(
            content=f"Error: {exc}", tool_call_id=request.tool_call["id"], status="error")]})


def _make_agent(tool_node: ToolNode, streaming: bool = True,
                model_class=_FakeToolCallingModel) -> LangGraphAgent:
    model = model_class(disable_streaming=not streaming)

    async def agent_node(state: MessagesState):
        return {"messages": [await model.ainvoke(state["messages"])]}

    graph = StateGraph(MessagesState)
    graph.add_node("agent", agent_node)
    graph.add_node("tools", tool_node)
    graph.add_edge(START, "agent")
    graph.add_conditional_edges("agent", tools_condition)
    graph.add_edge("tools", "agent")
    return LangGraphAgent(name="tool-error-result",
                          graph=graph.compile(checkpointer=MemorySaver()))


def _make_parallel_agent(*tool_nodes: ToolNode) -> LangGraphAgent:
    """Run one child graph per ToolNode concurrently, each calling ``call_1``."""
    def child(tool_node: ToolNode):
        def ask(state: MessagesState):
            return {"messages": [AIMessage(content="", tool_calls=[{
                "name": "get_weather", "args": {"city": "Paris"},
                "id": "call_1", "type": "tool_call"}])]}

        graph = StateGraph(MessagesState)
        graph.add_node("ask", ask)
        graph.add_node("tools", tool_node)
        graph.add_edge(START, "ask")
        graph.add_edge("ask", "tools")
        graph.add_edge("tools", END)
        return graph.compile()

    graph = StateGraph(MessagesState)
    for index, tool_node in enumerate(tool_nodes):
        graph.add_node(f"child_{index}", child(tool_node))
        graph.add_edge(START, f"child_{index}")
    return LangGraphAgent(name="tool-error-result-parallel",
                          graph=graph.compile(checkpointer=MemorySaver()))


async def _run(agent: LangGraphAgent, messages=None, run_id: str = "run-1") -> List:
    run_input = RunAgentInput(
        thread_id="thread-1", run_id=run_id, state={},
        messages=messages or [UserMessage(id="user-1", role="user", content="Weather in Paris?")],
        tools=[], context=[], forwarded_props={},
    )
    return [event async for event in agent.run(run_input) if not isinstance(event, str)]


class TestFailedToolCallResult(unittest.IsolatedAsyncioTestCase):

    def _assert_failed_result_streamed(self, events: List):
        types = [e.type for e in events]
        self.assertNotIn(EventType.RUN_ERROR, types)
        results = [e for e in events if e.type == EventType.TOOL_CALL_RESULT]
        self.assertEqual(len(results), 1, "expected one TOOL_CALL_RESULT for the failed call")
        result = results[0]

        # The call is announced exactly once, and closed before its result.
        starts = [i for i, e in enumerate(events)
                  if e.type == EventType.TOOL_CALL_START and e.tool_call_id == result.tool_call_id]
        ends = [i for i, e in enumerate(events)
                if e.type == EventType.TOOL_CALL_END and e.tool_call_id == result.tool_call_id]
        self.assertEqual(len(starts), 1)
        self.assertEqual(len(ends), 1)
        result_index = events.index(result)
        self.assertLess(ends[0], result_index)

        # Streamed during the run, before the next assistant response and the
        # final snapshot, not only inside that snapshot.
        self.assertLess(result_index, types.index(EventType.MESSAGES_SNAPSHOT))
        if EventType.TEXT_MESSAGE_START in types:
            self.assertLess(result_index, types.index(EventType.TEXT_MESSAGE_START))

        # It carries the message ToolNode stored, under the id the snapshot uses.
        snapshot = [e for e in events if e.type == EventType.MESSAGES_SNAPSHOT][-1]
        snapshot_tools = [m for m in snapshot.messages
                          if m.role == "tool" and m.tool_call_id == result.tool_call_id]
        self.assertEqual(len(snapshot_tools), 1)
        self.assertEqual(result.content, snapshot_tools[0].content)
        self.assertEqual(result.message_id, snapshot_tools[0].id)
        return result

    async def test_tool_exception_handled_by_tool_node(self):
        agent = _make_agent(ToolNode([get_weather], handle_tool_errors=True))
        result = self._assert_failed_result_streamed(await _run(agent))
        self.assertIn("service unavailable", result.content)

    async def test_invalid_arguments_with_default_error_handling(self):
        # ToolNode's default handler turns an argument validation error into an
        # error ToolMessage, with content that differs from the raised error.
        agent = _make_agent(ToolNode([get_weather_by_zip]))
        result = self._assert_failed_result_streamed(await _run(agent))
        self.assertIn("zip_code", result.content)

    async def test_non_streaming_model_announces_the_failed_call(self):
        # A model that did not stream its tool call leaves the announcement to
        # the adapter, as for a successful call at on_tool_end.
        agent = _make_agent(ToolNode([get_weather], handle_tool_errors=True), streaming=False)
        events = await _run(agent)
        result = self._assert_failed_result_streamed(events)
        args = [e for e in events
                if e.type == EventType.TOOL_CALL_ARGS and e.tool_call_id == result.tool_call_id]
        self.assertEqual("".join(a.delta for a in args), '{"city": "Paris"}')

    async def test_next_turn_does_not_replay_earlier_failures(self):
        agent = _make_agent(ToolNode([get_weather], handle_tool_errors=True))
        events = await _run(agent)
        first = self._assert_failed_result_streamed(events)
        snapshot = [e for e in events if e.type == EventType.MESSAGES_SNAPSHOT][-1]

        events2 = await _run(agent, run_id="run-2", messages=[
            *snapshot.messages,
            UserMessage(id="user-2", role="user", content="And in Lisbon?"),
        ])
        second = self._assert_failed_result_streamed(events2)
        self.assertNotEqual(second.tool_call_id, first.tool_call_id)

    async def test_failed_attempt_recovered_by_a_retry_streams_one_result(self):
        attempts = []

        @tool("get_weather")
        def flaky_weather(city: str) -> str:
            """Get weather. The first attempt fails."""
            attempts.append(city)
            if len(attempts) == 1:
                raise RuntimeError("service unavailable")
            return f"Sunny in {city}"

        async def retry_once(request, execute):
            try:
                return await execute(request)
            except RuntimeError:
                return await execute(request)

        agent = _make_agent(ToolNode([flaky_weather], handle_tool_errors=False,
                                     awrap_tool_call=retry_once))
        events = await _run(agent)
        self.assertEqual(len(attempts), 2)
        results = [e for e in events if e.type == EventType.TOOL_CALL_RESULT]
        self.assertEqual([r.content for r in results], ["Sunny in Paris"])

    async def test_error_handler_returning_a_command(self):
        # The wrapper catches the error, so no on_tool_end fires, and the
        # ToolNode's output holds a Command rather than the message itself.
        agent = _make_agent(ToolNode([get_weather], handle_tool_errors=False,
                                     awrap_tool_call=_error_to_command))
        events = await _run(agent)
        # The result must come before the next assistant response.
        self.assertIn(EventType.TEXT_MESSAGE_START, [e.type for e in events])
        result = self._assert_failed_result_streamed(events)
        self.assertEqual(result.content, "Error: service unavailable")

    async def test_interrupted_call_reusing_an_earlier_call_id_has_no_result(self):
        # The second turn reuses call_1 and the tool interrupts. The root
        # graph's output still holds the first turn's call_1 result, which is
        # not this call's result.
        for first_fails in (False, True):
            with self.subTest(first_fails=first_fails):
                calls = []

                @tool("get_weather")
                def weather_then_confirm(city: str) -> str:
                    """Get weather. Later calls ask the user first."""
                    calls.append(city)
                    if len(calls) > 1:
                        interrupt("Look up the weather again?")
                    if first_fails:
                        raise RuntimeError("service unavailable")
                    return f"Sunny in {city}"

                agent = _make_agent(ToolNode([weather_then_confirm], handle_tool_errors=True),
                                    model_class=_SameCallIdModel)
                events = await _run(agent)
                results = [e for e in events if e.type == EventType.TOOL_CALL_RESULT]
                self.assertEqual([r.tool_call_id for r in results], ["call_1"])
                snapshot = [e for e in events if e.type == EventType.MESSAGES_SNAPSHOT][-1]

                events2 = await _run(agent, run_id="run-2", messages=[
                    *snapshot.messages,
                    UserMessage(id="user-2", role="user", content="And again?"),
                ])
                self.assertEqual(len(calls), 2)
                types2 = [e.type for e in events2]
                self.assertNotIn(EventType.RUN_ERROR, types2)
                self.assertTrue(any(e.type == EventType.CUSTOM and e.name == "on_interrupt"
                                    for e in events2))
                self.assertNotIn(EventType.TOOL_CALL_RESULT, types2)

    async def test_concurrent_failures_sharing_a_call_id_both_stream(self):
        agent = _make_parallel_agent(ToolNode([get_weather], handle_tool_errors=True),
                                     ToolNode([get_weather], handle_tool_errors=True))
        events = await _run(agent)
        self.assertNotIn(EventType.RUN_ERROR, [e.type for e in events])
        results = [e for e in events if e.type == EventType.TOOL_CALL_RESULT]
        self.assertEqual([r.tool_call_id for r in results], ["call_1", "call_1"])
        for result in results:
            self.assertIn("service unavailable", result.content)

    async def test_failure_with_a_successful_sibling_sharing_the_call_id(self):
        # The sibling's success settles its own call_1, not the failed one.
        agent = _make_parallel_agent(ToolNode([get_weather], handle_tool_errors=True),
                                     ToolNode([get_weather_ok]))
        events = await _run(agent)
        self.assertNotIn(EventType.RUN_ERROR, [e.type for e in events])
        results = [e for e in events if e.type == EventType.TOOL_CALL_RESULT]
        self.assertEqual([r.tool_call_id for r in results], ["call_1", "call_1"])
        failed, succeeded = sorted(results, key=lambda r: r.content)
        self.assertIn("service unavailable", failed.content)
        self.assertEqual(succeeded.content, "Sunny in Paris")


if __name__ == "__main__":
    unittest.main()

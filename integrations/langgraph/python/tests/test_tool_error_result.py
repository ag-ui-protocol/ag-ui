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

from langchain_core.tools import tool
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import START, MessagesState, StateGraph
from langgraph.prebuilt import ToolNode, tools_condition

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


def _make_agent(tool_node: ToolNode, streaming: bool = True) -> LangGraphAgent:
    model = _FakeToolCallingModel(disable_streaming=not streaming)

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


if __name__ == "__main__":
    unittest.main()

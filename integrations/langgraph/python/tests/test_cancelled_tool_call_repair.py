"""Cancelling a run mid tool call must not wedge the thread (#2871).

When a run is cancelled while a tool is still executing, the checkpoint keeps
the ``AIMessage`` that carries ``tool_calls`` but no ``ToolMessage`` is ever
written for them. The next turn then hands the model an assistant message whose
tool calls are unanswered, which OpenAI and Azure OpenAI reject with a 400 and
which leaves the thread unusable until someone clears it.

These tests drive the real path: a graph with a slow tool behind
``LangGraphAgent``, a run cancelled after ``TOOL_CALL_START``, and a second turn
on the same thread. The fake chat model records exactly what it is handed, so
the assertion is about what reaches the provider rather than about a
hand-assembled message list.
"""

import asyncio
import unittest
import uuid
from typing import Any, List, Optional

from langchain_core.language_models import BaseChatModel
from langchain_core.messages import (
    AIMessage,
    AIMessageChunk,
    BaseMessage,
    HumanMessage,
    ToolMessage,
)
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult
from langchain_core.tools import tool
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, MessagesState, StateGraph
from langgraph.prebuilt import ToolNode, tools_condition

from ag_ui.core import (
    AssistantMessage,
    FunctionCall,
    RunAgentInput,
    ToolCall,
    UserMessage,
)
from ag_ui.core import ToolMessage as AguiToolMessage

from ag_ui_langgraph import LangGraphAgent
from ag_ui_langgraph.utils import agui_messages_to_langchain


TOOL_SLEEP_SECONDS = 2.0


def unanswered_tool_call_ids(messages: List[BaseMessage]) -> List[str]:
    """Tool call ids the provider contract requires an answer for.

    Mirrors the OpenAI rule: every id on an assistant message's ``tool_calls``
    must be answered by a ``ToolMessage`` before any other message follows.
    """
    unanswered: List[str] = []
    pending: List[str] = []
    for message in list(messages) + [HumanMessage(content="<end>")]:
        if isinstance(message, ToolMessage):
            if message.tool_call_id in pending:
                pending.remove(message.tool_call_id)
            continue
        unanswered.extend(pending)
        pending = []
        if isinstance(message, AIMessage):
            pending = [call["id"] for call in message.tool_calls]
    return unanswered


class RecordingModel(BaseChatModel):
    """A chat model that records every message list it is handed."""

    calls: List[List[BaseMessage]] = []

    @property
    def _llm_type(self) -> str:
        return "recording"

    def bind_tools(self, tools, **kwargs):  # noqa: ANN001 - langchain signature
        return self

    def _reply(self, messages: List[BaseMessage]) -> AIMessage:
        self.calls.append(list(messages))
        last = messages[-1]
        if isinstance(last, HumanMessage) and "weather" in str(last.content):
            return AIMessage(
                content="",
                id=f"ai-{uuid.uuid4().hex[:6]}",
                tool_calls=[
                    {
                        "name": "slow_weather",
                        "args": {"city": "Paris"},
                        "id": "call_1",
                        "type": "tool_call",
                    }
                ],
            )
        return AIMessage(content="ok", id=f"ai-{uuid.uuid4().hex[:6]}")

    def _generate(self, messages, stop=None, run_manager=None, **kwargs) -> ChatResult:
        return ChatResult(generations=[ChatGeneration(message=self._reply(messages))])

    async def _astream(self, messages, stop=None, run_manager=None, **kwargs):
        message = self._reply(messages)
        chunk = AIMessageChunk(
            content=message.content,
            id=message.id,
            tool_call_chunks=[
                {
                    "name": call["name"],
                    "args": '{"city": "Paris"}',
                    "id": call["id"],
                    "index": 0,
                }
                for call in message.tool_calls
            ],
        )
        yield ChatGenerationChunk(message=chunk)


@tool
async def slow_weather(city: str) -> str:
    """Get the weather, slowly."""
    await asyncio.sleep(TOOL_SLEEP_SECONDS)
    return f"{city}: sunny"


def build_graph(model: RecordingModel, stop_after_tools: bool = False):
    """The repro graph: agent -> tools -> agent, behind a MemorySaver.

    With ``stop_after_tools`` the graph ends at the tool node instead of
    looping back, so the checkpoint it leaves behind ends with an AIMessage
    whose tool calls ARE answered by the ToolMessage right after it. That is
    the shape the repair has to leave alone.
    """
    async def agent_node(state: MessagesState):
        return {"messages": [await model.ainvoke(state["messages"])]}

    graph = StateGraph(MessagesState)
    graph.add_node("agent", agent_node)
    graph.add_node("tools", ToolNode([slow_weather]))
    graph.add_edge(START, "agent")
    graph.add_conditional_edges("agent", tools_condition)
    graph.add_edge("tools", END if stop_after_tools else "agent")
    return graph.compile(checkpointer=MemorySaver())


class TestCancelledToolCallRepair(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.model = RecordingModel()
        self.model.calls = []
        self.graph = build_graph(self.model)
        self.agent = LangGraphAgent(name="cancel-test", graph=self.graph)
        self.thread_id = f"t-{uuid.uuid4().hex[:8]}"

    async def _turn(self, messages, cancel_after_tool_start: bool = False):
        run_input = RunAgentInput(
            thread_id=self.thread_id,
            run_id=str(uuid.uuid4()),
            state={},
            messages=messages,
            tools=[],
            context=[],
            forwarded_props={},
        )
        events: List[Any] = []

        async def consume():
            async for event in self.agent.run(run_input):
                events.append(event)

        task = asyncio.create_task(consume())
        if cancel_after_tool_start:
            deadline = asyncio.get_running_loop().time() + 10.0
            while not any(
                getattr(event, "type", None) is not None
                and event.type.value == "TOOL_CALL_START"
                for event in events
            ):
                if task.done() or asyncio.get_running_loop().time() > deadline:
                    break
                await asyncio.sleep(0.01)
            # The tool is now sleeping; cancel before its result can be written.
            await asyncio.sleep(0.2)
            task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        return events

    def _run_input(self, messages) -> RunAgentInput:
        return RunAgentInput(
            thread_id=self.thread_id,
            run_id=str(uuid.uuid4()),
            state={},
            messages=messages,
            tools=[],
            context=[],
            forwarded_props={},
        )

    async def _checkpoint_messages(self) -> List[BaseMessage]:
        snapshot = await self.graph.aget_state(
            {"configurable": {"thread_id": self.thread_id}}
        )
        return list(snapshot.values.get("messages", []))

    async def _cancel_first_turn(self) -> List[Any]:
        first_user = UserMessage(id="u1", role="user", content="what is the weather?")
        events = await self._turn([first_user], cancel_after_tool_start=True)
        starts = [e for e in events if e.type.value == "TOOL_CALL_START"]
        self.assertTrue(
            starts, "the run must reach TOOL_CALL_START before it is cancelled"
        )
        results = [e for e in events if e.type.value == "TOOL_CALL_RESULT"]
        self.assertFalse(
            results, "the tool must still be running when the run is cancelled"
        )
        return events

    def _client_transcript_after_cancel(self, events) -> list:
        """The transcript an AG-UI client holds after the cancelled turn."""
        start = next(e for e in events if e.type.value == "TOOL_CALL_START")
        return [
            UserMessage(id="u1", role="user", content="what is the weather?"),
            AssistantMessage(
                id=start.parent_message_id or "a1",
                role="assistant",
                tool_calls=[
                    ToolCall(
                        id=start.tool_call_id,
                        type="function",
                        function=FunctionCall(
                            name=start.tool_call_name,
                            arguments='{"city": "Paris"}',
                        ),
                    )
                ],
            ),
            UserMessage(id="u2", role="user", content="thanks, anything else?"),
        ]

    async def test_second_turn_model_input_has_no_unanswered_tool_call(self):
        events = await self._cancel_first_turn()
        transcript = self._client_transcript_after_cancel(events)

        calls_before = len(self.model.calls)
        await self._turn(transcript)
        second_turn_calls = self.model.calls[calls_before:]
        self.assertTrue(second_turn_calls, "the second turn must reach the model")

        for received in second_turn_calls:
            self.assertEqual(
                [],
                unanswered_tool_call_ids(received),
                "the model was handed an assistant tool call with no result: "
                f"{[type(m).__name__ for m in received]}",
            )

    async def test_cancelled_tool_call_is_answered_by_a_tool_message(self):
        events = await self._cancel_first_turn()
        transcript = self._client_transcript_after_cancel(events)

        calls_before = len(self.model.calls)
        await self._turn(transcript)
        second_turn_calls = self.model.calls[calls_before:]
        self.assertTrue(second_turn_calls, "the second turn must reach the model")

        received = second_turn_calls[0]
        answers = [
            message
            for message in received
            if isinstance(message, ToolMessage) and message.tool_call_id == "call_1"
        ]
        self.assertEqual(
            1,
            len(answers),
            "the cancelled tool call should be answered exactly once, got "
            f"{[type(m).__name__ for m in received]}",
        )
        self.assertIsInstance(answers[0].content, str)
        self.assertIn("cancel", answers[0].content.lower())

    async def test_resend_of_the_same_transcript_answers_nothing(self):
        """A client that re-sends the transcript unchanged is not a new turn.

        The tool call is still live — the graph is sitting at the tool node,
        about to run it — so answering it as cancelled would fabricate a result
        for a call that is about to produce a real one.
        """
        events = await self._cancel_first_turn()
        start = next(e for e in events if e.type.value == "TOOL_CALL_START")
        resend = [
            UserMessage(id="u1", role="user", content="what is the weather?"),
            AssistantMessage(
                id=start.parent_message_id or "a1",
                role="assistant",
                tool_calls=[
                    ToolCall(
                        id=start.tool_call_id,
                        type="function",
                        function=FunctionCall(
                            name=start.tool_call_name,
                            arguments='{"city": "Paris"}',
                        ),
                    )
                ],
            ),
        ]

        merged = self.agent.langgraph_default_merge_state(
            {"messages": await self._checkpoint_messages()},
            agui_messages_to_langchain(resend),
            self._run_input(resend),
        )
        synthesized = [
            message
            for message in merged["messages"]
            if isinstance(message, ToolMessage)
            and "cancelled" in str(message.content).lower()
        ]
        self.assertEqual(
            [], synthesized, "a resend must not fabricate a cancelled tool result"
        )

    async def test_answered_trailing_tool_call_is_left_alone(self):
        """A checkpoint ending with AI[tool_call] + its real result is intact.

        Nothing is dangling here, so the next turn must not add a second,
        cancelled answer alongside the real one.
        """
        self.model.calls = []
        self.graph = build_graph(self.model, stop_after_tools=True)
        self.agent = LangGraphAgent(name="cancel-test", graph=self.graph)

        first_user = UserMessage(id="u1", role="user", content="what is the weather?")
        events = await self._turn([first_user])
        self.assertTrue(
            [e for e in events if e.type.value == "TOOL_CALL_RESULT"],
            "the tool call must complete",
        )
        checkpoint = await self._checkpoint_messages()
        self.assertIsInstance(checkpoint[-1], ToolMessage)
        self.assertEqual("call_1", checkpoint[-1].tool_call_id)

        snapshots = [e for e in events if e.type.value == "MESSAGES_SNAPSHOT"]
        transcript = list(snapshots[-1].messages) if snapshots else []
        transcript.append(
            UserMessage(id="u2", role="user", content="thanks, anything else?")
        )

        calls_before = len(self.model.calls)
        await self._turn(transcript)
        second_turn_calls = self.model.calls[calls_before:]
        self.assertTrue(second_turn_calls, "the second turn must reach the model")

        received = second_turn_calls[0]
        answers = [
            message
            for message in received
            if isinstance(message, ToolMessage) and message.tool_call_id == "call_1"
        ]
        self.assertEqual(
            1,
            len(answers),
            "the answered tool call must not get a second, cancelled result: "
            f"{[(type(m).__name__, str(getattr(m, 'content', ''))[:40]) for m in received]}",
        )
        self.assertEqual("Paris: sunny", answers[0].content)

    async def test_completed_tool_call_is_not_given_a_synthetic_answer(self):
        """Control: a run that finishes normally keeps its real tool result."""
        first_user = UserMessage(id="u1", role="user", content="what is the weather?")
        events = await self._turn([first_user])
        results = [e for e in events if e.type.value == "TOOL_CALL_RESULT"]
        self.assertTrue(results, "the control run must complete its tool call")

        snapshots = [e for e in events if e.type.value == "MESSAGES_SNAPSHOT"]
        self.assertTrue(snapshots, "the control run must emit a messages snapshot")
        transcript = list(snapshots[-1].messages)
        transcript.append(
            UserMessage(id="u2", role="user", content="thanks, anything else?")
        )

        calls_before = len(self.model.calls)
        await self._turn(transcript)
        second_turn_calls = self.model.calls[calls_before:]
        self.assertTrue(second_turn_calls, "the second turn must reach the model")

        received = second_turn_calls[0]
        answers = [
            message
            for message in received
            if isinstance(message, ToolMessage) and message.tool_call_id == "call_1"
        ]
        self.assertEqual(1, len(answers), "the real tool result must not be duplicated")
        self.assertEqual("Paris: sunny", answers[0].content)


if __name__ == "__main__":
    unittest.main()

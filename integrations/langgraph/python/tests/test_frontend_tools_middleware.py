"""Tests for FrontendToolsMiddleware (ag-ui-protocol/ag-ui#892).

A ``create_agent()`` graph binds only the tools passed at construction
time, so a frontend tool arriving in ``RunAgentInput.tools`` was never
offered to the LLM: the integration merges those tools into
``state["tools"]``, but a plain ``create_agent()`` graph's ``AgentState``
has no ``tools`` channel and LangGraph drops the unknown input key before
any node or middleware sees it. These tests drive a real ``create_agent()``
graph with a recording fake model through ``LangGraphAgent.run`` and
assert the full loop: the frontend tool is bound, the backend never
executes it, the run finishes, and the checkpoint keeps the call so the
client's tool result can answer it on the next turn.
"""
import unittest

from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langchain_core.tools import tool as lc_tool
from pydantic import Field


@lc_tool
def get_current_date_and_time() -> str:
    """Tool to provide the current date and time in string format."""
    return "2026-11-07"


class RecordingModel(BaseChatModel):
    """Fake chat model that records every bind_tools call and cycles replies."""

    replies: list = Field(default_factory=list)
    bound_tools_history: list = Field(default_factory=list)
    _call_index: int = 0

    @property
    def _llm_type(self) -> str:
        return "recording-fake"

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        reply = self.replies[min(self._call_index, len(self.replies) - 1)]
        self._call_index += 1
        return ChatResult(generations=[ChatGeneration(message=reply)])

    def bind_tools(self, tools, **kwargs):
        self.bound_tools_history.append(list(tools))
        # The canned replies do not depend on the binding, so returning self
        # keeps the node runnable while recording exactly what was bound.
        return self


def _tool_names(bound_history):
    names = []
    for call in bound_history:
        for item in call:
            if isinstance(item, dict):
                names.append(item.get("name") or (item.get("function") or {}).get("name"))
            else:
                names.append(getattr(item, "name", None) or str(item))
    return names


class FrontendToolsEndToEnd(unittest.IsolatedAsyncioTestCase):
    """The #892 loop through a real create_agent() graph."""

    THREAD_ID = "thread-892"

    def _frontend_tool(self):
        from ag_ui.core import Tool

        return Tool(
            name="confirmAction",
            description="Ask the user to confirm a specific action before proceeding",
            parameters={
                "type": "object",
                "properties": {
                    "action": {"type": "string", "description": "The action that needs user confirmation"},
                    "importance": {
                        "type": "string",
                        "enum": ["low", "medium", "high", "critical"],
                        "description": "The importance level of the action",
                    },
                },
                "required": ["action"],
            },
        )

    def _make_agent(self, model, middleware=()):
        from langchain.agents import create_agent
        from langgraph.checkpoint.memory import MemorySaver

        graph = create_agent(
            model=model,
            tools=[get_current_date_and_time],
            middleware=list(middleware),
            checkpointer=MemorySaver(),
        )
        from ag_ui_langgraph.agent import LangGraphAgent

        return LangGraphAgent(name="test-892", graph=graph), graph

    def _run_input(self, run_id, tools, messages):
        from ag_ui.core import RunAgentInput

        return RunAgentInput(
            thread_id=self.THREAD_ID,
            run_id=run_id,
            state={},
            tools=tools,
            context=[],
            forwarded_props={},
            messages=messages,
        )

    async def _run(self, agent, run_input):
        from ag_ui.core import EventType

        events = [event async for event in agent.run(run_input)]
        return events

    def _confirm_call(self, call_id="call-1"):
        return AIMessage(
            content="",
            tool_calls=[{
                "id": call_id,
                "name": "confirmAction",
                "args": {"action": "delete file", "importance": "high"},
            }],
        )

    async def test_frontend_tool_is_bound_to_the_model_call(self):
        """The reported bug: the frontend tool must reach the LLM call."""
        from ag_ui.core import EventType, UserMessage
        from ag_ui_langgraph import FrontendToolsMiddleware

        model = RecordingModel(replies=[self._confirm_call(), AIMessage(content="Done.")])
        agent, _ = self._make_agent(model, middleware=[FrontendToolsMiddleware()])
        events = await self._run(
            agent,
            self._run_input(
                "run-892-bind", [self._frontend_tool()],
                [UserMessage(id="u1", role="user", content="hello")],
            ),
        )
        self.assertIn("confirmAction", _tool_names(model.bound_tools_history))
        self.assertIn("get_current_date_and_time", _tool_names(model.bound_tools_history))
        self.assertEqual(events[-1].type, EventType.RUN_FINISHED)

    async def test_without_middleware_the_frontend_tool_is_not_bound(self):
        """Control: the same setup without the middleware reproduces #892."""
        from ag_ui.core import UserMessage

        model = RecordingModel(replies=[self._confirm_call(), AIMessage(content="Done.")])
        agent, _ = self._make_agent(model)
        await self._run(
            agent,
            self._run_input(
                "run-892-control", [self._frontend_tool()],
                [UserMessage(id="u1", role="user", content="hello")],
            ),
        )
        self.assertNotIn("confirmAction", _tool_names(model.bound_tools_history))

    async def test_frontend_call_is_not_executed_by_the_backend(self):
        """The tools node must never answer a frontend call with a fake error.

        Without the after_model strip, ToolNode writes
        "confirmAction is not a valid tool" into the checkpoint and the real
        client result is then discarded as a duplicate.
        """
        from ag_ui.core import EventType, UserMessage
        from ag_ui_langgraph import FrontendToolsMiddleware

        model = RecordingModel(replies=[self._confirm_call(), AIMessage(content="Done.")])
        agent, graph = self._make_agent(model, middleware=[FrontendToolsMiddleware()])
        events = await self._run(
            agent,
            self._run_input(
                "run-892-noexec", [self._frontend_tool()],
                [UserMessage(id="u1", role="user", content="hello")],
            ),
        )
        self.assertEqual(events[-1].type, EventType.RUN_FINISHED)
        state = await graph.aget_state({"configurable": {"thread_id": self.THREAD_ID}})
        contents = [getattr(m, "content", "") for m in state.values["messages"]]
        self.assertFalse(
            any("is not a valid tool" in str(c) for c in contents),
            "backend fabricated an error result for the frontend call",
        )
        # The checkpoint keeps the call (restored by after_agent) so the
        # client's result can answer it next turn.
        ai_messages = [m for m in state.values["messages"] if isinstance(m, AIMessage)]
        called = [c["name"] for m in ai_messages for c in (m.tool_calls or [])]
        self.assertIn("confirmAction", called)

    async def test_client_tool_result_continues_the_run(self):
        """Turn 2: the client's ToolMessage answers the restored call."""
        from ag_ui.core import (
            AssistantMessage,
            EventType,
            ToolMessage,
            UserMessage,
        )
        from ag_ui_langgraph import FrontendToolsMiddleware

        model = RecordingModel(replies=[self._confirm_call(), AIMessage(content="Done.")])
        agent, graph = self._make_agent(model, middleware=[FrontendToolsMiddleware()])
        await self._run(
            agent,
            self._run_input(
                "run-892-t1", [self._frontend_tool()],
                [UserMessage(id="u1", role="user", content="hello")],
            ),
        )
        state = await graph.aget_state({"configurable": {"thread_id": self.THREAD_ID}})
        ai_message = next(m for m in state.values["messages"] if isinstance(m, AIMessage))
        events = await self._run(
            agent,
            self._run_input(
                "run-892-t2", [self._frontend_tool()],
                [
                    UserMessage(id="u1", role="user", content="hello"),
                    AssistantMessage(
                        id=ai_message.id,
                        role="assistant",
                        content="",
                        tool_calls=[{
                            "id": "call-1",
                            "type": "function",
                            "function": {
                                "name": "confirmAction",
                                "arguments": '{"action": "delete file", "importance": "high"}',
                            },
                        }],
                    ),
                    ToolMessage(id="tm1", role="tool", content="confirmed", tool_call_id="call-1"),
                ],
            ),
        )
        self.assertEqual(events[-1].type, EventType.RUN_FINISHED)
        self.assertEqual(len(model.bound_tools_history), 2)
        self.assertIn("confirmAction", _tool_names(model.bound_tools_history))
        state = await graph.aget_state({"configurable": {"thread_id": self.THREAD_ID}})
        contents = [getattr(m, "content", "") for m in state.values["messages"]]
        self.assertFalse(any("is not a valid tool" in str(c) for c in contents))

    async def test_mixed_backend_and_frontend_calls(self):
        """One turn calling both: the backend tool runs, the frontend one doesn't."""
        from ag_ui.core import EventType, UserMessage
        from ag_ui_langgraph import FrontendToolsMiddleware

        mixed = AIMessage(
            content="",
            tool_calls=[
                {
                    "id": "call-b",
                    "name": "get_current_date_and_time",
                    "args": {},
                },
                {
                    "id": "call-1",
                    "name": "confirmAction",
                    "args": {"action": "delete file", "importance": "high"},
                },
            ],
        )
        model = RecordingModel(replies=[mixed, AIMessage(content="Done.")])
        agent, graph = self._make_agent(model, middleware=[FrontendToolsMiddleware()])
        events = await self._run(
            agent,
            self._run_input(
                "run-892-mixed", [self._frontend_tool()],
                [UserMessage(id="u1", role="user", content="hello")],
            ),
        )
        self.assertEqual(events[-1].type, EventType.RUN_FINISHED)
        state = await graph.aget_state({"configurable": {"thread_id": self.THREAD_ID}})
        contents = [str(getattr(m, "content", "")) for m in state.values["messages"]]
        self.assertTrue(any("2026-11-07" in c for c in contents), "backend tool never ran")
        self.assertFalse(any("is not a valid tool" in c for c in contents))
        ai_messages = [m for m in state.values["messages"] if isinstance(m, AIMessage)]
        called = [c["name"] for m in ai_messages for c in (m.tool_calls or [])]
        self.assertIn("confirmAction", called)
        self.assertIn("get_current_date_and_time", called)

    async def test_no_frontend_tools_is_a_noop(self):
        """Without frontend tools the middleware changes nothing."""
        from ag_ui.core import EventType, UserMessage
        from ag_ui_langgraph import FrontendToolsMiddleware

        model = RecordingModel(replies=[AIMessage(content="Hi there.")])
        agent, _ = self._make_agent(model, middleware=[FrontendToolsMiddleware()])
        events = await self._run(
            agent,
            self._run_input(
                "run-892-noop", [],
                [UserMessage(id="u1", role="user", content="hello")],
            ),
        )
        self.assertEqual(events[-1].type, EventType.RUN_FINISHED)
        self.assertEqual(
            _tool_names(model.bound_tools_history), ["get_current_date_and_time"]
        )


class TestFrontendToolNormalization(unittest.TestCase):
    """Unit tests for the tool-shape normalization."""

    def test_flat_ag_ui_dict(self):
        from ag_ui_langgraph.middlewares.frontend_tools import _normalize_tool

        self.assertEqual(
            _normalize_tool({
                "name": "confirmAction",
                "description": "d",
                "parameters": {"type": "object", "properties": {}},
            }),
            {
                "name": "confirmAction",
                "description": "d",
                "parameters": {"type": "object", "properties": {}},
            },
        )

    def test_openai_function_shape_is_flattened(self):
        from ag_ui_langgraph.middlewares.frontend_tools import _normalize_tool

        self.assertEqual(
            _normalize_tool({
                "type": "function",
                "function": {
                    "name": "confirmAction",
                    "description": "d",
                    "parameters": {"type": "object", "properties": {}},
                },
            }),
            {
                "name": "confirmAction",
                "description": "d",
                "parameters": {"type": "object", "properties": {}},
            },
        )

    def test_unnamed_tool_is_dropped(self):
        from ag_ui_langgraph.middlewares.frontend_tools import _normalize_tool

        self.assertIsNone(_normalize_tool({"description": "no name"}))

    def test_backend_tools_win_on_name_collision(self):
        from unittest.mock import MagicMock

        from ag_ui_langgraph.middlewares.frontend_tools import FrontendToolsMiddleware

        middleware = FrontendToolsMiddleware()
        request = MagicMock()
        request.tools = [get_current_date_and_time]
        request.state = {
            "tools": [{
                "name": "get_current_date_and_time",
                "description": "frontend impostor",
                "parameters": {"type": "object", "properties": {}},
            }]
        }
        request.runtime = MagicMock()
        request.runtime.context = {}
        seen = []
        middleware.wrap_model_call(request, lambda r: seen.append(r.tools))
        self.assertEqual([t.name for t in seen[0]], ["get_current_date_and_time"])


if __name__ == "__main__":
    unittest.main()

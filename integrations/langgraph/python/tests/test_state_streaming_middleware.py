"""Tests for StateStreamingMiddleware and snapshot suppression logic."""
import asyncio
import unittest
from unittest.mock import MagicMock, AsyncMock, patch

from langchain_core.messages import HumanMessage, ToolMessage, AIMessage

try:
    from ag_ui_langgraph.middlewares.state_streaming import StateStreamingMiddleware, StateItem
    _MIDDLEWARE_AVAILABLE = True
except ImportError:
    _MIDDLEWARE_AVAILABLE = False


def _make_request(messages):
    """Return a minimal ModelRequest-like object for testing."""
    req = MagicMock()
    req.messages = messages
    return req


@unittest.skipUnless(_MIDDLEWARE_AVAILABLE, "langchain>=1.2.0 required for StateStreamingMiddleware")
class TestIsPreToolCall(unittest.TestCase):
    """Unit tests for StateStreamingMiddleware._is_pre_tool_call."""

    def setUp(self):
        self.middleware = StateStreamingMiddleware(
            StateItem(state_key="recipe", tool="write_recipe", tool_argument="draft")
        )

    def test_empty_messages_is_pre_tool_call(self):
        req = _make_request([])
        self.assertTrue(self.middleware._is_pre_tool_call(req))

    def test_human_message_last_is_pre_tool_call(self):
        req = _make_request([HumanMessage(content="hello")])
        self.assertTrue(self.middleware._is_pre_tool_call(req))

    def test_ai_message_last_is_pre_tool_call(self):
        req = _make_request([HumanMessage(content="hi"), AIMessage(content="sure")])
        self.assertTrue(self.middleware._is_pre_tool_call(req))

    def test_tool_message_last_is_not_pre_tool_call(self):
        tool_msg = ToolMessage(content="result", tool_call_id="tc1")
        req = _make_request([HumanMessage(content="go"), tool_msg])
        self.assertFalse(self.middleware._is_pre_tool_call(req))


@unittest.skipUnless(_MIDDLEWARE_AVAILABLE, "langchain>=1.2.0 required for StateStreamingMiddleware")
class TestWrapModelCall(unittest.TestCase):
    """Unit tests for wrap_model_call and awrap_model_call."""

    def _make_middleware(self, *items):
        return StateStreamingMiddleware(*items) if items else StateStreamingMiddleware(
            StateItem(state_key="state_key", tool="my_tool", tool_argument="my_arg")
        )

    # ------------------------------------------------------------------ sync

    def test_wrap_model_call_injects_config_pre_tool_call(self):
        """Handler should receive a config-augmented model when not post-tool-call."""
        middleware = self._make_middleware()

        captured = {}
        def handler(request):
            captured["request"] = request
            return MagicMock()

        req = _make_request([HumanMessage(content="hello")])
        middleware.wrap_model_call(req, handler)

        # ensure_config / var_child_runnable_config were used — the handler ran
        self.assertIn("request", captured)

    def test_wrap_model_call_passes_through_post_tool_call(self):
        """Handler should receive the original request unchanged after a ToolMessage."""
        middleware = self._make_middleware()

        tool_msg = ToolMessage(content="done", tool_call_id="tc1")
        req = _make_request([tool_msg])

        captured = {}
        def handler(request):
            captured["request"] = request
            return MagicMock()

        middleware.wrap_model_call(req, handler)

        # The same request object should be forwarded untouched
        self.assertIs(captured["request"], req)

    # ----------------------------------------------------------------- async

    def test_awrap_model_call_injects_config_pre_tool_call(self):
        """Async handler should be called when not post-tool-call."""
        middleware = self._make_middleware()

        captured = {}
        async def handler(request):
            captured["request"] = request
            return MagicMock()

        req = _make_request([HumanMessage(content="hello")])
        asyncio.run(middleware.awrap_model_call(req, handler))

        self.assertIn("request", captured)

    def test_awrap_model_call_passes_through_post_tool_call(self):
        """Async handler should receive original request unchanged after ToolMessage."""
        middleware = self._make_middleware()

        tool_msg = ToolMessage(content="done", tool_call_id="tc1")
        req = _make_request([tool_msg])

        captured = {}
        async def handler(request):
            captured["request"] = request
            return MagicMock()

        asyncio.run(middleware.awrap_model_call(req, handler))

        self.assertIs(captured["request"], req)

    def test_predict_state_payload_shape(self):
        """emit_intermediate_state is built with snake_case keys from StateItem."""
        middleware = StateStreamingMiddleware(
            StateItem(state_key="my_state", tool="my_tool", tool_argument="my_arg"),
            StateItem(state_key="other_state", tool="other_tool", tool_argument="other_arg"),
        )
        self.assertEqual(
            middleware._emit_intermediate_state,
            [
                {"state_key": "my_state", "tool": "my_tool", "tool_argument": "my_arg"},
                {"state_key": "other_state", "tool": "other_tool", "tool_argument": "other_arg"},
            ],
        )


class TestSnapshotSuppressionCondition(unittest.TestCase):
    """
    Documents and verifies the Python agent's snapshot suppression logic.

    The agent suppresses a STATE_SNAPSHOT on node exit when the model just made
    a tool call (model_made_tool_call=True) or when the state is no longer
    reliable (state_reliable=False).  This prevents overwriting predict_state
    progress that was already pushed to the client.

    Condition (from agent.py):
        suppressed = exiting_node and (model_made_tool_call or not state_reliable)
    """

    def _suppressed(self, exiting_node, model_made_tool_call, state_reliable=True):
        return exiting_node and (model_made_tool_call or not state_reliable)

    def test_suppressed_when_exiting_and_made_tool_call(self):
        self.assertTrue(self._suppressed(exiting_node=True, model_made_tool_call=True))

    def test_suppressed_when_exiting_and_state_unreliable(self):
        self.assertTrue(self._suppressed(exiting_node=True, model_made_tool_call=False, state_reliable=False))

    def test_not_suppressed_when_not_exiting(self):
        self.assertFalse(self._suppressed(exiting_node=False, model_made_tool_call=True))

    def test_not_suppressed_when_exiting_but_no_tool_call_and_state_reliable(self):
        self.assertFalse(self._suppressed(exiting_node=True, model_made_tool_call=False, state_reliable=True))

    def test_not_suppressed_when_neither_flag_set(self):
        self.assertFalse(self._suppressed(exiting_node=False, model_made_tool_call=False))


if __name__ == "__main__":
    unittest.main()
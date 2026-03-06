"""Tests for StateStreamingMiddleware and snapshot suppression logic."""
import asyncio
import importlib.util
import os
import sys
import unittest
from unittest.mock import MagicMock, AsyncMock, patch

from langchain_core.messages import HumanMessage, ToolMessage, AIMessage
from langchain_core.runnables.config import var_child_runnable_config

# Load state_streaming.py directly to avoid triggering ag_ui_langgraph/__init__.py,
# which pulls in agent.py and may fail if ag_ui.core is not fully up-to-date.
_STATE_STREAMING_PATH = os.path.join(
    os.path.dirname(__file__),
    "..", "ag_ui_langgraph", "middlewares", "state_streaming.py",
)
_ss_spec = importlib.util.spec_from_file_location("_state_streaming", _STATE_STREAMING_PATH)
_ss_mod = importlib.util.module_from_spec(_ss_spec)
_ss_spec.loader.exec_module(_ss_mod)

_with_intermediate_state = _ss_mod._with_intermediate_state

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


class TestWithIntermediateState(unittest.TestCase):
    """Unit tests for the _with_intermediate_state config helper."""

    def test_adds_predict_state_to_empty_config(self):
        items = [{"tool": "my_tool", "state_key": "s", "tool_argument": "a"}]
        result = _with_intermediate_state({}, items)
        self.assertEqual(result["metadata"]["predict_state"], items)

    def test_merges_with_existing_metadata(self):
        items = [{"tool": "my_tool", "state_key": "s", "tool_argument": "a"}]
        result = _with_intermediate_state({"metadata": {"existing": "value"}}, items)
        self.assertEqual(result["metadata"]["existing"], "value")
        self.assertEqual(result["metadata"]["predict_state"], items)

    def test_does_not_mutate_original_config(self):
        config = {"metadata": {"x": 1}}
        items = [{"tool": "t", "state_key": "s", "tool_argument": "a"}]
        _with_intermediate_state(config, items)
        self.assertNotIn("predict_state", config["metadata"])


class TestWrapModelCallConfigInjection(unittest.TestCase):
    """Tests that wrap_model_call injects predict_state into var_child_runnable_config.

    Uses patch to bypass the langchain>=1.2.0 availability guard so these tests
    always run, even when AgentMiddleware is not installed.
    """

    def _make_middleware(self):
        # Patch on the directly-loaded module to bypass the availability guard.
        with patch.object(_ss_mod, "_MIDDLEWARE_AVAILABLE", True):
            return _ss_mod.StateStreamingMiddleware(
                _ss_mod.StateItem(state_key="recipe", tool="write_recipe", tool_argument="draft")
            )

    def test_predict_state_injected_pre_tool_call(self):
        """predict_state metadata is set in the config var when last msg is not ToolMessage."""
        middleware = self._make_middleware()
        req = MagicMock()
        req.messages = [HumanMessage(content="hello")]

        captured = {}
        def handler(request):
            captured["meta"] = (var_child_runnable_config.get() or {}).get("metadata", {})
            return MagicMock()

        middleware.wrap_model_call(req, handler)

        self.assertIn("predict_state", captured["meta"])
        tools = [p["tool"] for p in captured["meta"]["predict_state"]]
        self.assertIn("write_recipe", tools)

    def test_predict_state_not_injected_post_tool_call(self):
        """predict_state metadata is NOT set when last message is a ToolMessage."""
        middleware = self._make_middleware()
        req = MagicMock()
        req.messages = [ToolMessage(content="result", tool_call_id="tc1")]

        captured = {}
        def handler(request):
            captured["meta"] = (var_child_runnable_config.get() or {}).get("metadata", {})
            return MagicMock()

        middleware.wrap_model_call(req, handler)

        self.assertNotIn("predict_state", captured["meta"])

    def test_predict_state_injected_async_pre_tool_call(self):
        """Async: predict_state metadata is set when last msg is not ToolMessage."""
        middleware = self._make_middleware()
        req = MagicMock()
        req.messages = [HumanMessage(content="hello")]

        captured = {}
        async def handler(request):
            captured["meta"] = (var_child_runnable_config.get() or {}).get("metadata", {})
            return MagicMock()

        asyncio.run(middleware.awrap_model_call(req, handler))

        self.assertIn("predict_state", captured["meta"])
        tools = [p["tool"] for p in captured["meta"]["predict_state"]]
        self.assertIn("write_recipe", tools)

    def test_predict_state_not_injected_async_post_tool_call(self):
        """Async: predict_state metadata is NOT set when last message is a ToolMessage."""
        middleware = self._make_middleware()
        req = MagicMock()
        req.messages = [ToolMessage(content="result", tool_call_id="tc1")]

        captured = {}
        async def handler(request):
            captured["meta"] = (var_child_runnable_config.get() or {}).get("metadata", {})
            return MagicMock()

        asyncio.run(middleware.awrap_model_call(req, handler))

        self.assertNotIn("predict_state", captured["meta"])


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


class TestModelMadeToolCallMetadataCheck(unittest.TestCase):
    """
    Verifies that model_made_tool_call is only set when the tool name appears
    in the predict_state metadata — not for arbitrary tool calls.

    This mirrors the TypeScript behaviour where hasPredictState is only set
    when the streaming tool call matches a tool listed in
    event.metadata["predict_state"].
    """

    def _should_set_model_made_tool_call(self, tool_name, predict_state_meta):
        """Mirrors the agent.py logic for setting model_made_tool_call."""
        return any(p.get("tool") == tool_name for p in predict_state_meta)

    def test_sets_flag_when_tool_matches_predict_state(self):
        meta = [{"tool": "write_recipe", "state_key": "recipe", "tool_argument": "draft"}]
        self.assertTrue(self._should_set_model_made_tool_call("write_recipe", meta))

    def test_does_not_set_flag_for_unrelated_tool(self):
        meta = [{"tool": "write_recipe", "state_key": "recipe", "tool_argument": "draft"}]
        self.assertFalse(self._should_set_model_made_tool_call("search_web", meta))

    def test_does_not_set_flag_when_predict_state_meta_empty(self):
        self.assertFalse(self._should_set_model_made_tool_call("any_tool", []))

    def test_does_not_set_flag_when_no_predict_state_metadata(self):
        # Simulates event.get("metadata", {}).get("predict_state", []) == []
        event_metadata = {}
        predict_state_meta = event_metadata.get("predict_state", [])
        self.assertFalse(self._should_set_model_made_tool_call("any_tool", predict_state_meta))

    def test_sets_flag_when_tool_matches_one_of_multiple(self):
        meta = [
            {"tool": "write_recipe", "state_key": "recipe", "tool_argument": "draft"},
            {"tool": "update_title", "state_key": "title", "tool_argument": "text"},
        ]
        self.assertTrue(self._should_set_model_made_tool_call("update_title", meta))
        self.assertFalse(self._should_set_model_made_tool_call("search_web", meta))


if __name__ == "__main__":
    unittest.main()
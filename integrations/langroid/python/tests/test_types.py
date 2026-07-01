"""Tests for type definitions and configuration classes."""

import asyncio
import unittest
from unittest.mock import MagicMock

from ag_ui.core import RunAgentInput
from ag_ui_langroid.types import (
    ToolCallContext,
    ToolResultContext,
    ToolBehavior,
    LangroidAgentConfig,
    maybe_await,
)


class TestToolCallContext(unittest.TestCase):
    """Test ToolCallContext dataclass."""

    def test_creation(self):
        input_data = MagicMock(spec=RunAgentInput)
        ctx = ToolCallContext(
            input_data=input_data,
            tool_name="get_weather",
            tool_call_id="tc-123",
            tool_input={"location": "NYC"},
            args_str='{"location": "NYC"}',
        )
        self.assertEqual(ctx.tool_name, "get_weather")
        self.assertEqual(ctx.tool_call_id, "tc-123")
        self.assertEqual(ctx.tool_input, {"location": "NYC"})
        self.assertEqual(ctx.args_str, '{"location": "NYC"}')
        self.assertIs(ctx.input_data, input_data)


class TestToolResultContext(unittest.TestCase):
    """Test ToolResultContext dataclass."""

    def test_inherits_from_tool_call_context(self):
        self.assertTrue(issubclass(ToolResultContext, ToolCallContext))

    def test_creation(self):
        input_data = MagicMock(spec=RunAgentInput)
        ctx = ToolResultContext(
            input_data=input_data,
            tool_name="get_weather",
            tool_call_id="tc-123",
            tool_input={"location": "NYC"},
            args_str='{"location": "NYC"}',
            result_data={"temperature": 72},
            message_id="msg-456",
        )
        self.assertEqual(ctx.result_data, {"temperature": 72})
        self.assertEqual(ctx.message_id, "msg-456")
        self.assertEqual(ctx.tool_name, "get_weather")


class TestToolBehavior(unittest.TestCase):
    """Test ToolBehavior dataclass."""

    def test_defaults_to_none(self):
        behavior = ToolBehavior()
        self.assertIsNone(behavior.state_from_args)
        self.assertIsNone(behavior.state_from_result)

    def test_with_callbacks(self):
        def from_args(ctx):
            return {"key": "value"}

        async def from_result(ctx):
            return {"result_key": "result_value"}

        behavior = ToolBehavior(
            state_from_args=from_args,
            state_from_result=from_result,
        )
        self.assertIs(behavior.state_from_args, from_args)
        self.assertIs(behavior.state_from_result, from_result)


class TestLangroidAgentConfig(unittest.TestCase):
    """Test LangroidAgentConfig TypedDict."""

    def test_empty_config(self):
        config = LangroidAgentConfig()
        self.assertIsInstance(config, dict)

    def test_with_tool_behaviors(self):
        behavior = ToolBehavior()
        config = LangroidAgentConfig(
            tool_behaviors={"my_tool": behavior},
        )
        self.assertEqual(config["tool_behaviors"]["my_tool"], behavior)

    def test_with_state_context_builder(self):
        def builder(input_data, msg):
            return f"Context: {msg}"

        config = LangroidAgentConfig(state_context_builder=builder)
        self.assertIs(config["state_context_builder"], builder)


class TestMaybeAwait(unittest.TestCase):
    """Test maybe_await utility function."""

    def test_regular_value(self):
        result = asyncio.new_event_loop().run_until_complete(maybe_await(42))
        self.assertEqual(result, 42)

    def test_none_value(self):
        result = asyncio.new_event_loop().run_until_complete(maybe_await(None))
        self.assertIsNone(result)

    def test_string_value(self):
        result = asyncio.new_event_loop().run_until_complete(maybe_await("hello"))
        self.assertEqual(result, "hello")

    def test_awaitable_value(self):
        async def async_fn():
            return 99

        result = asyncio.new_event_loop().run_until_complete(maybe_await(async_fn()))
        self.assertEqual(result, 99)

    def test_dict_value(self):
        d = {"key": "value"}
        result = asyncio.new_event_loop().run_until_complete(maybe_await(d))
        self.assertEqual(result, d)


if __name__ == "__main__":
    unittest.main()

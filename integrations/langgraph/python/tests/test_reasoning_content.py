"""Tests for resolve_reasoning_content handling of DeepSeek-style reasoning_content."""
import unittest
from unittest.mock import MagicMock
from ag_ui_langgraph.utils import resolve_reasoning_content


class TestResolveReasoningContentDeepSeek(unittest.TestCase):
    """Test that additional_kwargs.reasoning_content (DeepSeek-style) is handled."""

    def test_deepseek_reasoning_content_string(self):
        """When chunk has additional_kwargs.reasoning_content as a string, return LangGraphReasoning."""
        chunk = MagicMock()
        chunk.content = None
        chunk.additional_kwargs = {"reasoning_content": "thinking step by step"}

        result = resolve_reasoning_content(chunk)

        self.assertIsNotNone(result)
        self.assertEqual(result["type"], "text")
        self.assertEqual(result["text"], "thinking step by step")
        self.assertEqual(result["index"], 0)

    def test_deepseek_reasoning_content_empty_string(self):
        """When reasoning_content is empty string, return None (not a false positive)."""
        chunk = MagicMock()
        chunk.content = None
        chunk.additional_kwargs = {"reasoning_content": ""}

        result = resolve_reasoning_content(chunk)

        self.assertIsNone(result)

    def test_deepseek_reasoning_content_none(self):
        """When reasoning_content is None, return None."""
        chunk = MagicMock()
        chunk.content = None
        chunk.additional_kwargs = {"reasoning_content": None}

        result = resolve_reasoning_content(chunk)

        self.assertIsNone(result)

    def test_deepseek_reasoning_content_not_present(self):
        """When additional_kwargs has no reasoning_content, return None."""
        chunk = MagicMock()
        chunk.content = None
        chunk.additional_kwargs = {"some_other_key": "value"}

        result = resolve_reasoning_content(chunk)

        self.assertIsNone(result)

    def test_content_formats_take_priority_over_additional_kwargs(self):
        """When content has a valid reasoning block, it should be returned even if reasoning_content exists."""
        chunk = MagicMock()
        chunk.content = [{"type": "thinking", "thinking": "from content block"}]
        chunk.additional_kwargs = {"reasoning_content": "from additional_kwargs"}

        result = resolve_reasoning_content(chunk)

        self.assertIsNotNone(result)
        self.assertEqual(result["text"], "from content block")


if __name__ == "__main__":
    unittest.main()

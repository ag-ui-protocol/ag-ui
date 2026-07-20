"""Unit tests for the Strands -> AG-UI token usage mapping.

Imports the leaf `usage` module directly by path so the test does not pull in
the strands-dependent package `__init__`. Only `ag_ui.core` + pydantic needed.
"""
import importlib.util
import pathlib
import unittest

_USAGE_PATH = (
    pathlib.Path(__file__).resolve().parents[1] / "src" / "ag_ui_strands" / "usage.py"
)
_spec = importlib.util.spec_from_file_location("ag_ui_strands_usage_under_test", _USAGE_PATH)
usage = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(usage)


class TokenUsageFromStrandsTest(unittest.TestCase):
    def test_maps_accumulated_usage_dict(self):
        u = usage.token_usage_from_strands(
            {"inputTokens": 100, "outputTokens": 50, "totalTokens": 150},
            provider="bedrock",
            model="claude-sonnet-4",
        )
        self.assertEqual(u.provider, "bedrock")
        self.assertEqual(u.model, "claude-sonnet-4")
        self.assertEqual(u.input_tokens, 100)
        self.assertEqual(u.output_tokens, 50)
        self.assertEqual(u.total_tokens, 150)

    def test_maps_cache_read_tokens_when_present(self):
        u = usage.token_usage_from_strands(
            {"inputTokens": 10, "outputTokens": 5, "totalTokens": 15, "cacheReadInputTokens": 4},
        )
        self.assertEqual(u.cached_input_tokens, 4)

    def test_returns_none_for_empty(self):
        self.assertIsNone(usage.token_usage_from_strands(None))
        self.assertIsNone(usage.token_usage_from_strands({}))

    def test_returns_none_when_no_numeric_counts(self):
        self.assertIsNone(usage.token_usage_from_strands({"inputTokens": None}))

    def test_ignores_bool_masquerading_as_int(self):
        # bool is a subclass of int in Python; must not be treated as a count.
        u = usage.token_usage_from_strands({"inputTokens": True, "totalTokens": 7})
        self.assertIsNone(u.input_tokens)
        self.assertEqual(u.total_tokens, 7)


if __name__ == "__main__":
    unittest.main()

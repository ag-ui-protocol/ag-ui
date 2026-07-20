"""Unit tests for the LangGraph -> AG-UI token usage mapping.

Imports the leaf `usage` module directly by path so the test does not pull in
the langgraph-dependent package `__init__`. Only `ag_ui.core` + pydantic are
required on the path.
"""
import importlib.util
import pathlib
import unittest

_USAGE_PATH = pathlib.Path(__file__).resolve().parents[1] / "ag_ui_langgraph" / "usage.py"
_spec = importlib.util.spec_from_file_location("ag_ui_langgraph_usage_under_test", _USAGE_PATH)
usage = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(usage)


class TokenUsageFromChunkTest(unittest.TestCase):
    def test_maps_core_and_detail_fields(self):
        u = usage.token_usage_from_chunk(
            {
                "input_tokens": 100,
                "output_tokens": 50,
                "total_tokens": 150,
                "input_token_details": {"cache_read": 10},
                "output_token_details": {"reasoning": 20},
            },
            provider="anthropic",
            model="claude-sonnet-4",
        )
        self.assertEqual(u.provider, "anthropic")
        self.assertEqual(u.model, "claude-sonnet-4")
        self.assertEqual(u.input_tokens, 100)
        self.assertEqual(u.output_tokens, 50)
        self.assertEqual(u.total_tokens, 150)
        self.assertEqual(u.cached_input_tokens, 10)
        self.assertEqual(u.reasoning_tokens, 20)

    def test_returns_none_for_empty_metadata(self):
        self.assertIsNone(usage.token_usage_from_chunk(None, provider="p", model="m"))
        self.assertIsNone(usage.token_usage_from_chunk({}, provider="p", model="m"))

    def test_omits_absent_fields(self):
        u = usage.token_usage_from_chunk(
            {"input_tokens": 5}, provider=None, model=None
        )
        dumped = u.model_dump(by_alias=True, exclude_none=True)
        self.assertEqual(dumped, {"inputTokens": 5})


class AggregateTokenUsageTest(unittest.TestCase):
    def test_sums_entries_for_same_provider_model(self):
        entries = [
            usage.token_usage_from_chunk(
                {"input_tokens": 100, "output_tokens": 20, "total_tokens": 120},
                provider="openai",
                model="gpt-4o",
            ),
            usage.token_usage_from_chunk(
                {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15},
                provider="openai",
                model="gpt-4o",
            ),
        ]
        agg = usage.aggregate_token_usage(entries)
        self.assertEqual(len(agg), 1)
        self.assertEqual(agg[0].input_tokens, 110)
        self.assertEqual(agg[0].output_tokens, 25)
        self.assertEqual(agg[0].total_tokens, 135)

    def test_keeps_distinct_models_separate_and_ordered(self):
        entries = [
            usage.token_usage_from_chunk({"input_tokens": 1}, provider="openai", model="gpt-4o"),
            usage.token_usage_from_chunk({"input_tokens": 2}, provider="openai", model="gpt-4o-mini"),
            usage.token_usage_from_chunk({"input_tokens": 3}, provider="openai", model="gpt-4o"),
        ]
        agg = usage.aggregate_token_usage(entries)
        self.assertEqual([u.model for u in agg], ["gpt-4o", "gpt-4o-mini"])
        self.assertEqual(agg[0].input_tokens, 4)
        self.assertEqual(agg[1].input_tokens, 2)

    def test_empty_input_returns_empty_list(self):
        self.assertEqual(usage.aggregate_token_usage([]), [])

    def test_field_none_when_absent_in_all_group_members(self):
        entries = [
            usage.token_usage_from_chunk({"input_tokens": 1}, provider="p", model="m"),
            usage.token_usage_from_chunk({"input_tokens": 2}, provider="p", model="m"),
        ]
        agg = usage.aggregate_token_usage(entries)
        self.assertEqual(agg[0].input_tokens, 3)
        # output_tokens was never reported -> stays None, not 0
        self.assertIsNone(agg[0].output_tokens)


if __name__ == "__main__":
    unittest.main()

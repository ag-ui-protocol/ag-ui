"""Tests for make_json_safe and json_safe_stringify handling of unpicklable dataclasses."""

import asyncio
import unittest
from dataclasses import dataclass, field
from typing import Any

from ag_ui_langgraph.utils import make_json_safe, json_safe_stringify


@dataclass
class UnpicklableDataclass:
    """A dataclass with a field that cannot be deep-copied (like MCP tool objects)."""
    name: str
    value: int
    unpicklable: Any = field(default=None)


class TestMakeJsonSafeUnpicklable(unittest.TestCase):
    """Regression tests for GitHub issue #1203.

    make_json_safe and json_safe_stringify crash with
    'TypeError: cannot pickle _GatheringFuture object' when a dataclass
    contains fields referencing live asyncio objects (e.g. MCP tool closures).
    """

    def test_dataclass_with_asyncio_future(self):
        """make_json_safe should handle a dataclass whose field contains an asyncio Future."""
        loop = asyncio.new_event_loop()
        try:
            future = loop.create_future()
            obj = UnpicklableDataclass(name="test", value=42, unpicklable=future)
            result = make_json_safe(obj)
            self.assertIsInstance(result, dict)
            self.assertEqual(result["name"], "test")
            self.assertEqual(result["value"], 42)
            # The unpicklable field should be converted somehow (not crash)
            self.assertIn("unpicklable", result)
        finally:
            loop.close()

    def test_dataclass_with_resolved_asyncio_future(self):
        """make_json_safe should handle a dataclass containing a resolved asyncio Future."""
        loop = asyncio.new_event_loop()
        try:
            future = loop.create_future()
            future.set_result("done")
            obj = UnpicklableDataclass(name="task_test", value=99, unpicklable=future)
            result = make_json_safe(obj)
            self.assertIsInstance(result, dict)
            self.assertEqual(result["name"], "task_test")
            self.assertEqual(result["value"], 99)
        finally:
            loop.close()

    def test_dataclass_with_gathering_future(self):
        """make_json_safe should handle a dataclass containing a _GatheringFuture.

        This mirrors the exact crash from issue #1203 where asyncio.gather()
        creates a _GatheringFuture that cannot be pickled/deep-copied.
        """
        loop = asyncio.new_event_loop()
        try:
            async def _coro():
                return "result"

            # asyncio.gather() creates a _GatheringFuture internally
            gathering = asyncio.gather(_coro(), _coro())
            obj = UnpicklableDataclass(name="gather_test", value=77, unpicklable=gathering)
            result = make_json_safe(obj)
            self.assertIsInstance(result, dict)
            self.assertEqual(result["name"], "gather_test")
            self.assertEqual(result["value"], 77)
            self.assertIn("unpicklable", result)

            # Clean up: cancel the gathering future and drain pending tasks
            gathering.cancel()
            try:
                loop.run_until_complete(gathering)
            except (asyncio.CancelledError, Exception):
                pass
        finally:
            loop.close()

    def test_json_safe_stringify_with_unpicklable_dataclass(self):
        """json_safe_stringify should not crash on dataclasses with unpicklable fields."""
        loop = asyncio.new_event_loop()
        try:
            future = loop.create_future()
            obj = UnpicklableDataclass(name="stringify", value=7, unpicklable=future)
            result = json_safe_stringify(obj)
            self.assertIsInstance(result, dict)
            self.assertEqual(result["name"], "stringify")
            self.assertEqual(result["value"], 7)
        finally:
            loop.close()

    def test_dataclass_nested_in_dict(self):
        """make_json_safe should handle unpicklable dataclasses nested in dicts."""
        loop = asyncio.new_event_loop()
        try:
            future = loop.create_future()
            obj = UnpicklableDataclass(name="nested", value=1, unpicklable=future)
            data = {"key": obj, "other": "value"}
            result = make_json_safe(data)
            self.assertIsInstance(result, dict)
            self.assertEqual(result["key"]["name"], "nested")
            self.assertEqual(result["other"], "value")
        finally:
            loop.close()

    def test_normal_dataclass_still_works(self):
        """Ensure normal dataclasses without unpicklable fields still serialize correctly."""
        obj = UnpicklableDataclass(name="normal", value=10, unpicklable="safe_string")
        result = make_json_safe(obj)
        self.assertIsInstance(result, dict)
        self.assertEqual(result["name"], "normal")
        self.assertEqual(result["value"], 10)
        self.assertEqual(result["unpicklable"], "safe_string")


if __name__ == "__main__":
    unittest.main()

"""Tests for langgraph_default_merge_state context propagation.

Covers the A2UI schema extraction logic and the dual-write of
regular_context to both state["ag-ui"]["context"] and
state["copilotkit"]["context"].
"""

import logging
import re
import unittest
from pathlib import Path

from ag_ui.core import Context, RunAgentInput

from ag_ui_langgraph.agent import A2UI_SCHEMA_CONTEXT_DESCRIPTION
from tests._helpers import make_agent

# Resolve repo root relative to this test file:
# tests/ -> python/ -> langgraph/ -> integrations/ -> repo root
_REPO_ROOT = Path(__file__).resolve().parents[4]

A2UI_DESC = A2UI_SCHEMA_CONTEXT_DESCRIPTION


def _make_input(context=None, tools=None):
    """Build a minimal RunAgentInput with the given context."""
    return RunAgentInput(
        thread_id="t-1",
        run_id="r-1",
        state={},
        messages=[],
        tools=tools or [],
        context=context or [],
        forwarded_props={},
    )


class TestContextPropagation(unittest.TestCase):
    """Verify that regular context lands in both ag-ui and copilotkit state."""

    def test_regular_context_in_both_state_dicts(self):
        agent = make_agent()
        ctx = [
            Context(description="user prefs", value="dark-mode"),
            Context(description="locale", value="en-US"),
        ]
        result = agent.langgraph_default_merge_state({}, [], _make_input(context=ctx))

        self.assertEqual(result["ag-ui"]["context"], ctx)
        self.assertEqual(result["copilotkit"]["context"], ctx)

    def test_empty_context(self):
        agent = make_agent()
        result = agent.langgraph_default_merge_state({}, [], _make_input(context=[]))

        self.assertEqual(result["ag-ui"]["context"], [])
        self.assertEqual(result["copilotkit"]["context"], [])
        self.assertNotIn("a2ui_schema", result["ag-ui"])

    def test_dict_context_entries_propagated(self):
        """Verify the dict code path works when context entries bypass
        Pydantic validation (e.g. raw dicts from deserialized state)."""
        agent = make_agent()
        ctx = [
            {"description": "user prefs", "value": "dark-mode"},
            {"description": "locale", "value": "en-US"},
        ]
        # Pass dicts directly to langgraph_default_merge_state, bypassing
        # RunAgentInput validation which would coerce dicts to Context objects.
        inp = _make_input()
        inp.context = ctx  # type: ignore[assignment]
        result = agent.langgraph_default_merge_state({}, [], inp)

        self.assertEqual(result["ag-ui"]["context"], ctx)
        self.assertEqual(result["copilotkit"]["context"], ctx)

    def test_none_context(self):
        agent = make_agent()
        inp = _make_input()
        inp.context = None
        result = agent.langgraph_default_merge_state({}, [], inp)

        self.assertEqual(result["ag-ui"]["context"], [])
        self.assertEqual(result["copilotkit"]["context"], [])


class TestA2UISchemaExtraction(unittest.TestCase):
    """Verify that the A2UI schema entry is extracted into ag-ui state
    and excluded from regular context."""

    def test_a2ui_schema_extracted(self):
        agent = make_agent()
        a2ui_entry = Context(description=A2UI_DESC, value='{"Button": {}}')
        regular = Context(description="other", value="val")
        ctx = [regular, a2ui_entry]

        result = agent.langgraph_default_merge_state({}, [], _make_input(context=ctx))

        self.assertEqual(result["ag-ui"]["a2ui_schema"], '{"Button": {}}')
        self.assertEqual(result["ag-ui"]["context"], [regular])
        self.assertEqual(result["copilotkit"]["context"], [regular])

    def test_a2ui_schema_extracted_from_dict_entries(self):
        """Verify A2UI extraction works when context entries are plain dicts."""
        agent = make_agent()
        a2ui_entry = {"description": A2UI_DESC, "value": '{"Button": {}}'}
        regular = {"description": "other", "value": "val"}
        inp = _make_input()
        inp.context = [regular, a2ui_entry]  # type: ignore[assignment]

        result = agent.langgraph_default_merge_state({}, [], inp)

        self.assertEqual(result["ag-ui"]["a2ui_schema"], '{"Button": {}}')
        self.assertEqual(result["ag-ui"]["context"], [regular])
        self.assertEqual(result["copilotkit"]["context"], [regular])

    def test_mismatched_description_stays_in_regular(self):
        agent = make_agent()
        wrong = Context(
            description="A2UI Component Schema \u2014 ...props...",
            value="schema",
        )
        result = agent.langgraph_default_merge_state({}, [], _make_input(context=[wrong]))

        self.assertNotIn("a2ui_schema", result["ag-ui"])
        self.assertEqual(result["ag-ui"]["context"], [wrong])

    def test_mixed_context_partitioning(self):
        agent = make_agent()
        r1 = Context(description="d1", value="v1")
        r2 = Context(description="d2", value="v2")
        a2ui = Context(description=A2UI_DESC, value="schema-json")
        ctx = [r1, a2ui, r2]

        result = agent.langgraph_default_merge_state({}, [], _make_input(context=ctx))

        self.assertEqual(result["ag-ui"]["a2ui_schema"], "schema-json")
        self.assertEqual(result["ag-ui"]["context"], [r1, r2])
        self.assertEqual(result["copilotkit"]["context"], [r1, r2])


class TestCopilotKitStatePreservation(unittest.TestCase):
    """Ensure the copilotkit state spread preserves existing keys."""

    def test_existing_keys_preserved(self):
        agent = make_agent()
        state = {"copilotkit": {"custom_key": "preserved"}}
        result = agent.langgraph_default_merge_state(state, [], _make_input())

        self.assertEqual(result["copilotkit"]["custom_key"], "preserved")
        self.assertEqual(result["copilotkit"]["context"], [])
        self.assertIn("actions", result["copilotkit"])

    def test_stale_context_overridden(self):
        agent = make_agent()
        state = {"copilotkit": {"context": ["stale"]}}
        fresh = [Context(description="new", value="val")]
        result = agent.langgraph_default_merge_state(state, [], _make_input(context=fresh))

        self.assertEqual(result["copilotkit"]["context"], fresh)

    def test_none_copilotkit_state_does_not_crash(self):
        agent = make_agent()
        state = {"copilotkit": None}
        result = agent.langgraph_default_merge_state(state, [], _make_input())

        self.assertEqual(result["copilotkit"]["context"], [])
        self.assertIn("actions", result["copilotkit"])


class TestA2UIMismatchWarning(unittest.TestCase):
    """Verify that a logger warning fires when an A2UI-related context
    entry doesn't match the expected description string."""

    def test_warning_on_near_miss(self):
        agent = make_agent()
        wrong = Context(
            description="A2UI Component Schema \u2014 old props version",
            value="schema",
        )
        with self.assertLogs("ag_ui_langgraph.agent", level="WARNING") as cm:
            agent.langgraph_default_merge_state({}, [], _make_input(context=[wrong]))

        self.assertTrue(
            any("did not match" in msg for msg in cm.output),
            f"expected mismatch warning, got: {cm.output}",
        )

    def test_warning_on_duplicate_a2ui_entries(self):
        agent = make_agent()
        a2ui_1 = Context(description=A2UI_DESC, value='{"Button": {}}')
        a2ui_2 = Context(description=A2UI_DESC, value='{"Card": {}}')
        with self.assertLogs("ag_ui_langgraph.agent", level="WARNING") as cm:
            result = agent.langgraph_default_merge_state(
                {}, [], _make_input(context=[a2ui_1, a2ui_2])
            )

        self.assertTrue(
            any("Found 2" in msg for msg in cm.output),
            f"expected duplicate warning, got: {cm.output}",
        )
        # Last value wins
        self.assertEqual(result["ag-ui"]["a2ui_schema"], '{"Card": {}}')
        self.assertEqual(result["ag-ui"]["context"], [])
        self.assertEqual(result["copilotkit"]["context"], [])

    def test_no_warning_when_matched(self):
        agent = make_agent()
        correct = Context(description=A2UI_DESC, value="schema")
        logger = logging.getLogger("ag_ui_langgraph.agent")
        with self.assertRaises(AssertionError):
            # assertLogs raises AssertionError when no logs are emitted
            with self.assertLogs(logger, level="WARNING"):
                agent.langgraph_default_merge_state(
                    {}, [], _make_input(context=[correct])
                )

    def test_no_warning_when_no_a2ui_entries(self):
        agent = make_agent()
        regular = Context(description="just regular", value="val")
        with self.assertRaises(AssertionError):
            with self.assertLogs("ag_ui_langgraph.agent", level="WARNING"):
                agent.langgraph_default_merge_state(
                    {}, [], _make_input(context=[regular])
                )


class TestCrossLanguageStringParity(unittest.TestCase):
    """Verify the A2UI description string is identical in the Python
    integration and the TypeScript middleware — the cross-language contract
    that caused a silent failure when the Python string used "props" while
    the TypeScript string used "properties", preventing A2UI schema extraction."""

    _TS_PATH = (
        _REPO_ROOT
        / "middlewares/a2ui-middleware/src/index.ts"
    )

    @staticmethod
    def _extract_ts_constant(source: str) -> str:
        match = re.search(
            r'A2UI_SCHEMA_CONTEXT_DESCRIPTION\s*=\s*"([^"]+)"', source
        )
        if not match:
            raise AssertionError("could not find A2UI_SCHEMA_CONTEXT_DESCRIPTION in TypeScript source")
        return match.group(1)

    def test_python_and_typescript_strings_match(self):
        ts_src = self._TS_PATH.read_text(encoding="utf-8")
        ts_val = self._extract_ts_constant(ts_src)

        self.assertEqual(
            A2UI_DESC,
            ts_val,
            "A2UI_SCHEMA_CONTEXT_DESCRIPTION has diverged between Python and TypeScript. "
            f"Python: {A2UI_DESC!r}  TypeScript: {ts_val!r}",
        )


if __name__ == "__main__":
    unittest.main()

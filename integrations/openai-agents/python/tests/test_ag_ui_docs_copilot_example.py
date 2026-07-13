"""Tests for the AG-UI Docs Copilot example."""

from __future__ import annotations

import inspect
import sys
from pathlib import Path

EXAMPLES = Path(__file__).resolve().parents[1] / "examples"
sys.path.insert(0, str(EXAMPLES))

from agents_examples import ag_ui_docs_copilot  # noqa: E402


def test_docs_copilot_loads_the_integration_readme() -> None:
    assert "AG-UI × OpenAI Agents SDK" in ag_ui_docs_copilot.DOCS
    assert "AGUITranslator" in ag_ui_docs_copilot.DOCS


def test_docs_copilot_has_a_documentation_specialist_tool() -> None:
    assert ag_ui_docs_copilot.copilot_agent.name == "AG-UI Docs Copilot"
    assert {tool.name for tool in ag_ui_docs_copilot.copilot_agent.tools} == {
        "ask_ag_ui_docs"
    }
    assert ag_ui_docs_copilot.docs_agent.name == "AG-UI Documentation Specialist"


def test_docs_copilot_keeps_the_direct_translator_flow_visible() -> None:
    assert "/" in {route.path for route in ag_ui_docs_copilot.app.routes}
    source = inspect.getsource(ag_ui_docs_copilot.run_ag_ui_docs_copilot)
    assert "translator.to_sdk(body)" in source
    assert "Runner.run_streamed(" in source
    assert "translator.to_agui(result, body)" in source

"""Tests for the AG-UI Docs Copilot example."""

from __future__ import annotations

import inspect
import sys
from pathlib import Path

EXAMPLES = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(EXAMPLES))

from agents_examples import ag_ui_docs_copilot  # noqa: E402


def test_docs_copilot_loads_the_integration_readme() -> None:
    assert "AG-UI × OpenAI Agents SDK" in ag_ui_docs_copilot.AG_UI_OPENAI_AGENTS_DOCS
    assert "AGUITranslator" in ag_ui_docs_copilot.AG_UI_OPENAI_AGENTS_DOCS
    assert "ag-ui-protocol" in ag_ui_docs_copilot.AG_UI_PROTOCOL_DOCS
    assert "EventEncoder" in ag_ui_docs_copilot.AG_UI_PROTOCOL_DOCS


def test_docs_copilot_has_a_documentation_specialist_tool() -> None:
    assert ag_ui_docs_copilot.copilot_agent.name == "AG-UI Docs Copilot"
    assert {tool.name for tool in ag_ui_docs_copilot.copilot_agent.tools} == {
        "ask_ag_ui_openai_agents_docs",
        "ask_ag_ui_protocol_docs",
    }
    assert (
        ag_ui_docs_copilot.ag_ui_openai_agents_docs_agent.name
        == "AG-UI OpenAI Agents Specialist"
    )
    assert (
        ag_ui_docs_copilot.ag_ui_protocol_docs_agent.name
        == "AG-UI Protocol Python Specialist"
    )


def test_docs_copilot_keeps_the_direct_translator_flow_visible() -> None:
    assert "/" in {route.path for route in ag_ui_docs_copilot.app.routes}
    source = inspect.getsource(ag_ui_docs_copilot.run_ag_ui_docs_copilot)
    assert "translator.to_openai(body)" in source
    assert "Runner.run_streamed(" in source
    assert "translator.to_agui(result, body)" in source

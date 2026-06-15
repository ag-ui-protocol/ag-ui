"""Integration tests for the LangGraph A2UI tool factory (``get_a2ui_tools``).

These run in the ``langgraph-python`` unit job, which builds the LOCAL adapter
and (via the adapter's ``[tool.uv.sources]`` path) the LOCAL toolkit — so they
exercise the real in-repo code. The dojo e2e suite can't cover this: it installs
the PUBLISHED ``ag-ui-langgraph`` (the langgraph-cloud build rejects local path
deps that escape the examples root), so the new single-arg ``A2UIToolParams`` /
``guidelines`` surface has no e2e coverage until it ships. This file is that
coverage.

A lightweight fake chat model records the system prompt it receives and returns
a fixed ``render_a2ui`` tool call, so we can assert both the emitted operations
envelope and that the generation/design/composition guidance actually reaches
the subagent.
"""

from __future__ import annotations

import json
import unittest
from types import SimpleNamespace

from ag_ui_langgraph import get_a2ui_tools
from ag_ui_a2ui_toolkit import (
    A2UI_OPERATIONS_KEY,
    DEFAULT_DESIGN_GUIDELINES,
    DEFAULT_GENERATION_GUIDELINES,
)


# A structurally-valid render_a2ui result (root present, child resolves, no
# cycle) so the toolkit's recovery/validation commits on the first attempt.
VALID_ARGS = {
    "surfaceId": "s1",
    "components": [
        {"id": "root", "component": "Column", "children": ["t"]},
        {"id": "t", "component": "Text", "text": "hi"},
    ],
    "data": {},
}


class _BoundModel:
    """What ``model.bind_tools(...)`` returns — records the system prompt it is
    invoked with and replays a fixed structured-output tool call."""

    def __init__(self, parent: "FakeModel"):
        self._parent = parent

    def invoke(self, messages):
        # The adapter invokes with [SystemMessage(prompt), *history]; capture the
        # system prompt so tests can assert what guidance the subagent saw.
        self._parent.captured_prompts.append(messages[0].content)
        return SimpleNamespace(tool_calls=[{"args": self._parent.args}])


class FakeModel:
    """Minimal chat-model stand-in: only ``bind_tools`` + ``invoke`` are used."""

    def __init__(self, args):
        self.args = args
        self.captured_prompts: list[str] = []

    def bind_tools(self, tools, tool_choice=None):
        return _BoundModel(self)


class FakeRuntime:
    """Stand-in for LangGraph's ``ToolRuntime`` — the tool only reads
    ``runtime.state``."""

    def __init__(self, state):
        self.state = state


def _invoke_tool(tool, runtime, **kwargs) -> str:
    """Call the tool's underlying function directly with a stub runtime,
    bypassing the graph's runtime injection."""
    return tool.func(runtime, **kwargs)


class TestGetA2UITools(unittest.TestCase):
    def _make(self, guidelines=None, tool_name=None):
        model = FakeModel(VALID_ARGS)
        params = {"model": model, "default_catalog_id": "cat://custom"}
        if guidelines is not None:
            params["guidelines"] = guidelines
        if tool_name is not None:
            params["tool_name"] = tool_name
        return get_a2ui_tools(params), model

    def test_single_arg_params_produces_operations_envelope(self):
        # Guards the exact regression that broke CI: the factory must accept a
        # single A2UIToolParams dict (model inside) and drive a render.
        tool, _model = self._make()
        envelope = _invoke_tool(
            tool, FakeRuntime({"messages": []}), intent="create"
        )
        parsed = json.loads(envelope)
        ops = parsed[A2UI_OPERATIONS_KEY]
        self.assertTrue(any("createSurface" in o for o in ops))
        self.assertTrue(any("updateComponents" in o for o in ops))
        # Catalog ownership stays with the host (from params), never the model.
        create = next(o for o in ops if "createSurface" in o)
        self.assertEqual(create["createSurface"]["catalogId"], "cat://custom")

    def test_default_guidelines_reach_the_subagent_prompt(self):
        # No guidelines passed → the built-in generation + design defaults must
        # be injected into the subagent system prompt (OSS-248 re-enable).
        tool, model = self._make()
        _invoke_tool(tool, FakeRuntime({"messages": []}), intent="create")
        prompt = model.captured_prompts[0]
        self.assertIn(DEFAULT_GENERATION_GUIDELINES, prompt)
        self.assertIn("## Design Guidelines", prompt)
        self.assertIn(DEFAULT_DESIGN_GUIDELINES, prompt)

    def test_composition_guide_and_overrides_flow_through(self):
        tool, model = self._make(
            guidelines={
                "generation_guidelines": "CUSTOM_GEN",
                "composition_guide": "COMPMARK",
            }
        )
        _invoke_tool(tool, FakeRuntime({"messages": []}), intent="create")
        prompt = model.captured_prompts[0]
        # Per-field override replaces generation; design keeps its default.
        self.assertIn("CUSTOM_GEN", prompt)
        self.assertNotIn(DEFAULT_GENERATION_GUIDELINES, prompt)
        self.assertIn(DEFAULT_DESIGN_GUIDELINES, prompt)
        self.assertIn("COMPMARK", prompt)

    def test_tool_name_resolves(self):
        default_tool, _ = self._make()
        self.assertEqual(default_tool.name, "generate_a2ui")
        custom_tool, _ = self._make(tool_name="render_ui")
        self.assertEqual(custom_tool.name, "render_ui")


if __name__ == "__main__":
    unittest.main()

"""Tests for client_proxy_tool module."""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from ag_ui.core import Tool as AgUiTool
from strands.tools.registry import ToolRegistry
from strands.tools.tools import PythonAgentTool

from ag_ui_strands.client_proxy_tool import (
    _PROXY_MARKER,
    _is_proxy,
    create_proxy_tool,
    sync_proxy_tools,
)
from ag_ui_strands.config import ToolBehavior
from ag_ui_strands.frontend_tool_wait import (
    FRONTEND_TOOL_WAIT_INTERRUPT_NAME,
    frontend_tool_wait_reason,
    wrap_frontend_tool_response,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_ag_ui_tool(name: str, description: str = "desc", parameters: dict | None = None) -> AgUiTool:
    """Create an AG-UI Tool instance."""
    return AgUiTool(name=name, description=description, parameters=parameters or {})


def _make_native_tool(name: str) -> PythonAgentTool:
    """Create a non-proxy PythonAgentTool (simulating a server-side tool)."""

    def _func(tool_use, **kwargs):
        return {"toolUseId": tool_use["toolUseId"], "status": "success", "content": [{"text": "native"}]}

    _func.__name__ = name
    spec = {"name": name, "description": "native", "inputSchema": {"json": {}}}
    return PythonAgentTool(tool_name=name, tool_spec=spec, tool_func=_func)


def _make_interrupt_agent():
    """Provide the public ToolContext API with the interrupt state it uses."""
    return SimpleNamespace(_interrupt_state=SimpleNamespace(interrupts={}))


async def _stream_tool(proxy, tool_use, agent=None):
    invocation_state = {"agent": agent or _make_interrupt_agent()}
    return [event async for event in proxy.stream(tool_use, invocation_state)]


# ---------------------------------------------------------------------------
# Tests: create_proxy_tool
# ---------------------------------------------------------------------------

class TestCreateProxyTool:
    @pytest.mark.asyncio
    async def test_omitted_mode_preserves_legacy_placeholder_behavior(self):
        proxy = create_proxy_tool(_make_ag_ui_tool("legacy"))

        events = await _stream_tool(
            proxy,
            {"toolUseId": "legacy-id", "name": "legacy", "input": {}},
        )

        assert events == [
            {
                "tool_result": {
                    "toolUseId": "legacy-id",
                    "status": "success",
                    "content": [{"text": "Forwarded to client"}],
                }
            }
        ]

    def test_returns_python_agent_tool(self):
        ag_tool = _make_ag_ui_tool("my_tool", "A tool", {"type": "object", "properties": {"x": {"type": "string"}}})
        proxy = create_proxy_tool(ag_tool, continue_after_frontend_call=True)

        assert isinstance(proxy, PythonAgentTool)
        assert proxy.tool_name == "my_tool"
        assert proxy.tool_spec["name"] == "my_tool"
        assert proxy.tool_spec["description"] == "A tool"
        assert proxy.tool_spec["inputSchema"] == {
            "json": {"type": "object", "properties": {"x": {"type": "string"}}}
        }

    def test_marked_dynamic(self):
        proxy = create_proxy_tool(
            _make_ag_ui_tool("t"), continue_after_frontend_call=False
        )
        assert proxy.is_dynamic is True

    def test_marked_as_proxy(self):
        proxy = create_proxy_tool(
            _make_ag_ui_tool("t"), continue_after_frontend_call=False
        )
        assert getattr(proxy, _PROXY_MARKER) is True
        assert _is_proxy(proxy) is True

    def test_supports_hot_reload(self):
        proxy = create_proxy_tool(
            _make_ag_ui_tool("t"), continue_after_frontend_call=False
        )
        assert proxy.supports_hot_reload is True

    def test_interrupting_proxy_advertises_original_client_schema(self):
        proxy = create_proxy_tool(
            _make_ag_ui_tool(
                "my_tool",
                "A tool",
                {"type": "object", "properties": {"x": {"type": "string"}}},
            ),
            continue_after_frontend_call=False,
        )

        assert proxy.tool_spec == {
            "name": "my_tool",
            "description": "A tool",
            "inputSchema": {
                "json": {
                    "type": "object",
                    "properties": {"x": {"type": "string"}},
                }
            },
        }


class TestProxyToolResult:
    @pytest.mark.asyncio
    async def test_continue_mode_returns_exact_result_without_native_interrupt(self):
        proxy = create_proxy_tool(
            _make_ag_ui_tool("bg"), continue_after_frontend_call=True
        )
        tool_use = {"toolUseId": "abc-123", "name": "bg", "input": {}}

        events = await _stream_tool(proxy, tool_use)

        assert events == [
            {
                "tool_result": {
                    "toolUseId": "abc-123",
                    "status": "success",
                    "content": [{"text": "Forwarded to client"}],
                }
            }
        ]

    @pytest.mark.asyncio
    async def test_interrupt_mode_first_invocation_yields_tagged_native_interrupt(self):
        proxy = create_proxy_tool(
            _make_ag_ui_tool(
                "bg",
                parameters={
                    "type": "object",
                    "properties": {"color": {"type": "string"}},
                    "required": ["color"],
                },
            ),
            continue_after_frontend_call=False,
        )
        tool_use = {
            "toolUseId": "native-123",
            "name": "bg",
            "input": {"color": "red"},
        }

        events = await _stream_tool(proxy, tool_use)

        assert proxy.tool_spec["inputSchema"] == {
            "json": {
                "type": "object",
                "properties": {"color": {"type": "string"}},
                "required": ["color"],
            }
        }
        assert len(events) == 1
        interrupt_event = events[0]["tool_interrupt_event"]
        assert interrupt_event["tool_use"] == tool_use
        assert len(interrupt_event["interrupts"]) == 1
        interrupt = interrupt_event["interrupts"][0]
        assert interrupt.name == FRONTEND_TOOL_WAIT_INTERRUPT_NAME
        assert interrupt.reason == frontend_tool_wait_reason(
            native_tool_use_id="native-123"
        )

    @pytest.mark.asyncio
    async def test_interrupt_mode_resumes_with_empty_success_result(self):
        proxy = create_proxy_tool(
            _make_ag_ui_tool("bg"), continue_after_frontend_call=False
        )
        tool_use = {"toolUseId": "native-empty", "name": "bg", "input": {}}
        agent = _make_interrupt_agent()
        first_events = await _stream_tool(proxy, tool_use, agent)
        interrupt = first_events[0]["tool_interrupt_event"]["interrupts"][0]
        interrupt.response = wrap_frontend_tool_response("", is_error=False)

        resumed_events = await _stream_tool(proxy, tool_use, agent)

        assert resumed_events == [
            {
                "tool_result": {
                    "toolUseId": "native-empty",
                    "status": "success",
                    "content": [{"text": ""}],
                }
            }
        ]

    @pytest.mark.asyncio
    async def test_interrupt_mode_resumes_with_error_result(self):
        proxy = create_proxy_tool(
            _make_ag_ui_tool("bg"), continue_after_frontend_call=False
        )
        tool_use = {"toolUseId": "native-error", "name": "bg", "input": {}}
        agent = _make_interrupt_agent()
        first_events = await _stream_tool(proxy, tool_use, agent)
        interrupt = first_events[0]["tool_interrupt_event"]["interrupts"][0]
        interrupt.response = wrap_frontend_tool_response("client failed", is_error=True)

        resumed_events = await _stream_tool(proxy, tool_use, agent)

        assert resumed_events == [
            {
                "tool_result": {
                    "toolUseId": "native-error",
                    "status": "error",
                    "content": [{"text": "client failed"}],
                }
            }
        ]

    @pytest.mark.asyncio
    async def test_interrupt_mode_stream_returns_error_for_untagged_resume(self):
        proxy = create_proxy_tool(
            _make_ag_ui_tool("bg"), continue_after_frontend_call=False
        )
        tool_use = {"toolUseId": "native-bad", "name": "bg", "input": {}}
        agent = _make_interrupt_agent()
        first_events = await _stream_tool(proxy, tool_use, agent)
        interrupt = first_events[0]["tool_interrupt_event"]["interrupts"][0]
        interrupt.response = {"content": "not tagged"}

        resumed_events = await _stream_tool(proxy, tool_use, agent)

        assert resumed_events == [
            {
                "tool_result": {
                    "toolUseId": "native-bad",
                    "status": "error",
                    "content": [
                        {
                            "text": "Error: malformed frontend tool response envelope"
                        }
                    ],
                }
            }
        ]


# ---------------------------------------------------------------------------
# Tests: sync_proxy_tools
# ---------------------------------------------------------------------------

class TestSyncProxyTools:
    def _fresh_registry(self) -> ToolRegistry:
        return ToolRegistry()

    def test_adds_new_tools(self):
        registry = self._fresh_registry()
        tools = [_make_ag_ui_tool("tool_a"), _make_ag_ui_tool("tool_b")]

        result = sync_proxy_tools(registry, tools, set(), tool_behaviors={})

        assert result == {"tool_a", "tool_b"}
        assert "tool_a" in registry.registry
        assert "tool_b" in registry.registry
        assert _is_proxy(registry.registry["tool_a"])
        assert _is_proxy(registry.registry["tool_b"])

    @pytest.mark.asyncio
    async def test_omitted_behaviors_preserve_legacy_placeholder_behavior(self):
        registry = self._fresh_registry()

        sync_proxy_tools(registry, [_make_ag_ui_tool("legacy")], set())
        events = await _stream_tool(
            registry.registry["legacy"],
            {"toolUseId": "legacy-sync-id", "name": "legacy", "input": {}},
        )

        assert events == [
            {
                "tool_result": {
                    "toolUseId": "legacy-sync-id",
                    "status": "success",
                    "content": [{"text": "Forwarded to client"}],
                }
            }
        ]

    def test_removes_stale_tools(self):
        registry = self._fresh_registry()
        # First, register two proxy tools
        proxy_a = create_proxy_tool(
            _make_ag_ui_tool("tool_a"), continue_after_frontend_call=False
        )
        proxy_b = create_proxy_tool(
            _make_ag_ui_tool("tool_b"), continue_after_frontend_call=False
        )
        registry.register_tool(proxy_a)
        registry.register_tool(proxy_b)

        # Now sync with only tool_a — tool_b should be removed
        result = sync_proxy_tools(
            registry,
            [_make_ag_ui_tool("tool_a")],
            {"tool_a", "tool_b"},
            tool_behaviors={},
        )

        assert result == {"tool_a"}
        assert "tool_a" in registry.registry
        assert "tool_b" not in registry.registry
        assert "tool_b" not in registry.dynamic_tools

    def test_preserves_native_tools(self):
        registry = self._fresh_registry()
        native = _make_native_tool("my_native")
        registry.register_tool(native)

        # Try to register a proxy with the same name — should be skipped
        tools = [_make_ag_ui_tool("my_native")]
        result = sync_proxy_tools(registry, tools, set(), tool_behaviors={})

        assert result == set()  # not tracked as proxy
        assert "my_native" in registry.registry
        assert _is_proxy(registry.registry["my_native"]) is False

    def test_removes_all_when_empty_list(self):
        registry = self._fresh_registry()
        proxy = create_proxy_tool(
            _make_ag_ui_tool("tool_x"), continue_after_frontend_call=False
        )
        registry.register_tool(proxy)

        result = sync_proxy_tools(registry, [], {"tool_x"}, tool_behaviors={})

        assert result == set()
        assert "tool_x" not in registry.registry

    def test_idempotent_re_registration(self):
        """Re-syncing the same tools should work (hot reload)."""
        registry = self._fresh_registry()
        tools = [_make_ag_ui_tool("t1")]

        r1 = sync_proxy_tools(registry, tools, set(), tool_behaviors={})
        r2 = sync_proxy_tools(registry, tools, r1, tool_behaviors={})

        assert r1 == r2 == {"t1"}
        assert "t1" in registry.registry

    @pytest.mark.asyncio
    async def test_explicit_empty_behaviors_default_proxy_to_interrupt_mode(self):
        registry = self._fresh_registry()
        sync_proxy_tools(
            registry, [_make_ag_ui_tool("default_wait")], set(), tool_behaviors={}
        )

        events = await _stream_tool(
            registry.registry["default_wait"],
            {"toolUseId": "native-default", "name": "default_wait", "input": {}},
        )

        assert "tool_interrupt_event" in events[0]

    @pytest.mark.asyncio
    async def test_registered_proxy_snapshots_continue_behavior(self):
        registry = self._fresh_registry()
        behavior = ToolBehavior(continue_after_frontend_call=True)
        sync_proxy_tools(
            registry,
            [_make_ag_ui_tool("snapshotted")],
            set(),
            tool_behaviors={"snapshotted": behavior},
        )
        proxy = registry.registry["snapshotted"]

        behavior.continue_after_frontend_call = False
        events = await _stream_tool(
            proxy,
            {
                "toolUseId": "native-snapshot",
                "name": "snapshotted",
                "input": {},
            },
        )

        assert events == [
            {
                "tool_result": {
                    "toolUseId": "native-snapshot",
                    "status": "success",
                    "content": [{"text": "Forwarded to client"}],
                }
            }
        ]

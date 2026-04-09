"""Regression tests for AGUIToolset delegation (GitHub #1389).

Verifies that AGUIToolset delegates to ClientProxyToolset via bind(),
so that frontend tools are available even when a Runner caches the
original AGUIToolset reference during initialization.
"""

import asyncio

import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from ag_ui.core import Tool as AGUITool, RunAgentInput, UserMessage, RunStartedEvent
from ag_ui_adk.agui_toolset import AGUIToolset
from ag_ui_adk.client_proxy_toolset import ClientProxyToolset
from ag_ui_adk import ADKAgent
from google.adk.agents import Agent


# -- Fixtures ----------------------------------------------------------------


@pytest.fixture
def frontend_tools():
    """Minimal set of frontend tool definitions."""
    return [
        AGUITool(
            name="widgetRenderer",
            description="Renders a frontend widget",
            parameters={
                "type": "object",
                "properties": {"component": {"type": "string"}},
            },
        ),
        AGUITool(
            name="formSubmitter",
            description="Submits a form from the frontend",
            parameters={
                "type": "object",
                "properties": {"formId": {"type": "string"}},
            },
        ),
    ]


@pytest.fixture
def event_queue():
    return asyncio.Queue()


# -- Unit tests: AGUIToolset -------------------------------------------------


class TestAGUIToolsetDelegation:
    """Unit tests for AGUIToolset.bind() / get_tools() delegation."""

    @pytest.mark.asyncio
    async def test_get_tools_returns_empty_before_bind(self):
        """Before bind() is called, get_tools() must return [] (not raise)."""
        toolset = AGUIToolset()
        tools = await toolset.get_tools()
        assert tools == []

    @pytest.mark.asyncio
    async def test_get_tools_delegates_after_bind(self, frontend_tools, event_queue):
        """After bind(), get_tools() returns the delegate's tools."""
        agui_ts = AGUIToolset()
        proxy_ts = ClientProxyToolset(
            ag_ui_tools=frontend_tools,
            event_queue=event_queue,
        )
        agui_ts.bind(proxy_ts)

        tools = await agui_ts.get_tools()
        tool_names = {t.name for t in tools}
        assert tool_names == {"widgetRenderer", "formSubmitter"}

    @pytest.mark.asyncio
    async def test_bind_replaces_previous_delegate(self, frontend_tools, event_queue):
        """Calling bind() a second time replaces the delegate."""
        agui_ts = AGUIToolset()

        first_proxy = ClientProxyToolset(
            ag_ui_tools=frontend_tools[:1],
            event_queue=event_queue,
        )
        agui_ts.bind(first_proxy)
        assert len(await agui_ts.get_tools()) == 1

        second_proxy = ClientProxyToolset(
            ag_ui_tools=frontend_tools,
            event_queue=event_queue,
        )
        agui_ts.bind(second_proxy)
        assert len(await agui_ts.get_tools()) == 2

    @pytest.mark.asyncio
    async def test_tool_filter_preserved_through_delegation(self, frontend_tools, event_queue):
        """tool_filter on AGUIToolset is forwarded to ClientProxyToolset."""
        agui_ts = AGUIToolset(tool_filter=["widgetRenderer"])
        proxy_ts = ClientProxyToolset(
            ag_ui_tools=frontend_tools,
            event_queue=event_queue,
            tool_filter=agui_ts.tool_filter,
        )
        agui_ts.bind(proxy_ts)

        tools = await agui_ts.get_tools()
        assert len(tools) == 1
        assert tools[0].name == "widgetRenderer"

    @pytest.mark.asyncio
    async def test_close_delegates_to_bound_toolset(self, frontend_tools, event_queue):
        """close() should call delegate.close()."""
        agui_ts = AGUIToolset()
        proxy_ts = ClientProxyToolset(
            ag_ui_tools=frontend_tools,
            event_queue=event_queue,
        )
        agui_ts.bind(proxy_ts)

        # Spy on delegate close
        proxy_ts.close = AsyncMock()
        await agui_ts.close()
        proxy_ts.close.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_close_noop_before_bind(self):
        """close() before bind() should not raise."""
        agui_ts = AGUIToolset()
        await agui_ts.close()  # must not raise


# -- Integration: cached-reference scenario ----------------------------------


class TestCachedReferenceScenario:
    """Simulates the ADK 2.0 scenario where Runner caches AGUIToolset
    during init, and tools must still resolve after bind().
    """

    @pytest.mark.asyncio
    async def test_cached_ref_resolves_after_bind(self, frontend_tools, event_queue):
        """Simulates Runner caching AGUIToolset, then bind() being called."""
        # 1. Agent configured with AGUIToolset
        agui_ts = AGUIToolset()

        # 2. Simulate Runner caching the toolset reference
        cached_ref = agui_ts

        # 3. Before bind: cached ref returns empty
        assert await cached_ref.get_tools() == []

        # 4. bind() happens (as _update_agent_tools_recursive does)
        proxy_ts = ClientProxyToolset(
            ag_ui_tools=frontend_tools,
            event_queue=event_queue,
        )
        agui_ts.bind(proxy_ts)

        # 5. Cached ref now resolves to real tools
        tools = await cached_ref.get_tools()
        assert len(tools) == 2
        assert {t.name for t in tools} == {"widgetRenderer", "formSubmitter"}


# -- Integration: _start_background_execution binds correctly ----------------


class TestBackgroundExecutionBinding:
    """Verifies that _start_background_execution binds
    ClientProxyToolset to AGUIToolset (not replaces it).
    """

    @pytest.mark.asyncio
    async def test_background_execution_binds_agui_toolset(self, frontend_tools):
        """After _start_background_execution, AGUIToolset.get_tools()
        should delegate to ClientProxyToolset.
        """
        root_agent = Agent(
            name="test_root",
            model="gemini-2.5-flash",
            tools=[AGUIToolset()],
        )

        adk_agent = ADKAgent(
            adk_agent=root_agent,
            app_name="test_app",
            user_id="test_user",
            use_in_memory_services=True,
        )

        # Capture the agent passed to _run_adk_in_background
        with patch.object(
            adk_agent,
            "_run_adk_in_background",
            new_callable=AsyncMock,
        ) as mocked:
            mocked.return_value = None

            async def fake_run():
                async for e in adk_agent.run(
                    RunAgentInput(
                        thread_id="t1",
                        run_id="r1",
                        messages=[
                            UserMessage(id="m1", role="user", content="hi"),
                        ],
                        tools=frontend_tools,
                        context=[],
                        state={},
                        forwarded_props={},
                    )
                ):
                    if not isinstance(e, RunStartedEvent):
                        break

            await fake_run()
            mocked.assert_called_once()
            agent_under_test = mocked.call_args.kwargs["adk_agent"]

            # The original AGUIToolset instance should still be in the list
            assert len(agent_under_test.tools) == 1
            toolset = agent_under_test.tools[0]
            assert isinstance(toolset, AGUIToolset)

            # But it should have a ClientProxyToolset bound
            assert isinstance(toolset._delegate, ClientProxyToolset)

            # And get_tools() should return the frontend tools
            tools = await toolset.get_tools()
            assert {t.name for t in tools} == {"widgetRenderer", "formSubmitter"}

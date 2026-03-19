"""Tests for session manager provider integration in StrandsAgent."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from ag_ui.core import EventType, RunAgentInput
from ag_ui_strands.agent import StrandsAgent
from ag_ui_strands.config import StrandsAgentConfig


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_run_input(thread_id: str | None = "thread-1", run_id: str = "run-1") -> RunAgentInput:
    return RunAgentInput(
        thread_id=thread_id,
        run_id=run_id,
        state={},
        messages=[],
        tools=[],
        context=[],
        forwarded_props={},
    )


async def _collect_events(agent: StrandsAgent, input_data: RunAgentInput) -> list:
    events = []
    async for event in agent.run(input_data):
        events.append(event)
    return events


async def _empty_async_gen():
    """Async generator that yields nothing, simulating a completed agent stream."""
    return
    yield  # pragma: no cover — makes this an async generator


def _make_base_agent(session_manager_provider=None) -> StrandsAgent:
    """Create a StrandsAgent with a mocked underlying Strands agent."""
    mock_core = MagicMock()
    mock_core.model = MagicMock()
    mock_core.system_prompt = "You are a test assistant."
    mock_core.tool_registry = MagicMock()
    mock_core.tool_registry.registry = {}
    mock_core.record_direct_tool_call = True

    config = StrandsAgentConfig(session_manager_provider=session_manager_provider)
    return StrandsAgent(agent=mock_core, name="test_agent", config=config)


def _make_mock_instance():
    instance = MagicMock()
    instance.tool_registry = MagicMock()
    instance.tool_registry.registry = {}
    instance.stream_async = MagicMock(side_effect=lambda _: _empty_async_gen())
    return instance


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestSessionManagerProvider:
    @pytest.mark.asyncio
    async def test_provider_called_for_new_thread(self):
        """Provider is invoked exactly once when a new thread is first seen."""
        mock_session_manager = MagicMock()
        provider = MagicMock(return_value=mock_session_manager)
        agent = _make_base_agent(session_manager_provider=provider)
        input_data = _make_run_input(thread_id="new-thread")

        with patch("ag_ui_strands.agent.StrandsAgentCore") as MockCore:
            MockCore.return_value = _make_mock_instance()
            await _collect_events(agent, input_data)

        provider.assert_called_once_with(input_data)
        _, kwargs = MockCore.call_args
        assert kwargs.get("session_manager") is mock_session_manager

    @pytest.mark.asyncio
    async def test_provider_not_called_for_existing_thread(self):
        """Provider is NOT called again for subsequent requests on the same thread."""
        mock_session_manager = MagicMock()
        provider = MagicMock(return_value=mock_session_manager)
        agent = _make_base_agent(session_manager_provider=provider)
        thread_id = "cached-thread"

        with patch("ag_ui_strands.agent.StrandsAgentCore") as MockCore:
            MockCore.return_value = _make_mock_instance()
            await _collect_events(agent, _make_run_input(thread_id=thread_id, run_id="run-1"))
            await _collect_events(agent, _make_run_input(thread_id=thread_id, run_id="run-2"))

        # Provider and constructor each called only once despite two runs
        provider.assert_called_once()
        MockCore.assert_called_once()

    @pytest.mark.asyncio
    async def test_provider_exception_yields_error_events(self):
        """When the provider raises, RunStartedEvent and RunErrorEvent are yielded."""
        def failing_provider(input_data):
            raise RuntimeError("session store unavailable")

        agent = _make_base_agent(session_manager_provider=failing_provider)

        with patch("ag_ui_strands.agent.StrandsAgentCore") as MockCore:
            events = await _collect_events(agent, _make_run_input())

        # StrandsAgentCore should never be constructed
        MockCore.assert_not_called()

        event_types = [e.type for e in events]
        assert EventType.RUN_STARTED in event_types
        assert EventType.RUN_ERROR in event_types
        # Early return means no RUN_FINISHED
        assert EventType.RUN_FINISHED not in event_types

        error_event = next(e for e in events if e.type == EventType.RUN_ERROR)
        assert "session store unavailable" in error_event.message
        assert error_event.code == "SESSION_MANAGER_ERROR"

    @pytest.mark.asyncio
    async def test_async_provider_is_awaited(self):
        """Async provider functions are properly awaited and their result used."""
        mock_session_manager = MagicMock()

        async def async_provider(input_data):
            return mock_session_manager

        agent = _make_base_agent(session_manager_provider=async_provider)
        input_data = _make_run_input(thread_id="async-thread")

        with patch("ag_ui_strands.agent.StrandsAgentCore") as MockCore:
            MockCore.return_value = _make_mock_instance()
            events = await _collect_events(agent, input_data)

        event_types = [e.type for e in events]
        assert EventType.RUN_STARTED in event_types
        assert EventType.RUN_FINISHED in event_types
        assert EventType.RUN_ERROR not in event_types

        _, kwargs = MockCore.call_args
        assert kwargs.get("session_manager") is mock_session_manager

    @pytest.mark.asyncio
    async def test_no_provider_passes_none_session_manager(self):
        """When no provider is configured, session_manager=None is passed."""
        agent = _make_base_agent(session_manager_provider=None)

        with patch("ag_ui_strands.agent.StrandsAgentCore") as MockCore:
            MockCore.return_value = _make_mock_instance()
            await _collect_events(agent, _make_run_input())

        _, kwargs = MockCore.call_args
        assert kwargs.get("session_manager") is None

    @pytest.mark.asyncio
    async def test_empty_thread_id_uses_default_key(self):
        """Empty/falsy thread_id falls back to the 'default' cache key."""
        provider = MagicMock(return_value=MagicMock())
        agent = _make_base_agent(session_manager_provider=provider)

        with patch("ag_ui_strands.agent.StrandsAgentCore") as MockCore:
            MockCore.return_value = _make_mock_instance()
            await _collect_events(agent, _make_run_input(thread_id=""))

        provider.assert_called_once()
        assert "default" in agent._agents_by_thread

    @pytest.mark.asyncio
    async def test_provider_returns_none_logs_warning(self, caplog):
        """Provider returning None logs a warning but continues the run."""
        import logging

        provider = MagicMock(return_value=None)
        agent = _make_base_agent(session_manager_provider=provider)

        with patch("ag_ui_strands.agent.StrandsAgentCore") as MockCore:
            MockCore.return_value = _make_mock_instance()
            with caplog.at_level(logging.WARNING, logger="ag_ui_strands.agent"):
                events = await _collect_events(agent, _make_run_input())

        event_types = [e.type for e in events]
        assert EventType.RUN_FINISHED in event_types
        assert any("returned None" in msg for msg in caplog.messages)

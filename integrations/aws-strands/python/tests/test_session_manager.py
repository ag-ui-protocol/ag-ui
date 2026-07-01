"""Tests for session manager provider integration in StrandsAgent."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest
from strands.session import SessionManager

from ag_ui.core import (
    EventType,
    RunAgentInput,
    Tool,
    ToolMessage,
    UserMessage,
)
from ag_ui_strands.agent import StrandsAgent
from ag_ui_strands.config import StrandsAgentConfig


def _mock_session_manager() -> MagicMock:
    """Create a MagicMock that passes isinstance(..., SessionManager)."""
    return MagicMock(spec=SessionManager)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_run_input(
    thread_id: str | None = "thread-1",
    run_id: str = "run-1",
    messages=None,
) -> RunAgentInput:
    return RunAgentInput(
        thread_id=thread_id,
        run_id=run_id,
        state={},
        messages=messages or [],
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


class _MockStrandsAgentWithPrivateSessionManager:
    def __init__(self, session_manager):
        self._session_manager = session_manager
        self.tool_registry = MagicMock()
        self.tool_registry.registry = {}
        self.stream_prompts = []

    async def stream_async(self, prompt):
        self.stream_prompts.append(prompt)
        return
        yield  # pragma: no cover


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestSessionManagerProvider:
    @pytest.mark.asyncio
    async def test_provider_called_for_new_thread(self):
        """Provider is invoked exactly once when a new thread is first seen."""
        mock_session_manager = _mock_session_manager()
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
        mock_session_manager = _mock_session_manager()
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
        mock_session_manager = _mock_session_manager()

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
        provider = MagicMock(return_value=_mock_session_manager())
        agent = _make_base_agent(session_manager_provider=provider)

        with patch("ag_ui_strands.agent.StrandsAgentCore") as MockCore:
            MockCore.return_value = _make_mock_instance()
            await _collect_events(agent, _make_run_input(thread_id=""))

        provider.assert_called_once()
        assert "default" in agent._agents_by_thread

    @pytest.mark.asyncio
    async def test_provider_failure_does_not_cache_thread(self):
        """A failed provider must not cache the thread — the next request
        must re-invoke the provider so a transient failure can recover."""
        call_count = {"n": 0}

        def flaky_provider(_input_data):
            call_count["n"] += 1
            raise RuntimeError(f"failure #{call_count['n']}")

        agent = _make_base_agent(session_manager_provider=flaky_provider)

        with patch("ag_ui_strands.agent.StrandsAgentCore"):
            await _collect_events(agent, _make_run_input(thread_id="retry-thread", run_id="r1"))
            assert "retry-thread" not in agent._agents_by_thread, (
                "thread must not be cached after provider failure"
            )
            await _collect_events(agent, _make_run_input(thread_id="retry-thread", run_id="r2"))

        assert call_count["n"] == 2, (
            f"provider must be re-invoked on the next request; got {call_count['n']} call(s)"
        )

    @pytest.mark.asyncio
    async def test_provider_returning_invalid_type_yields_error(self):
        """Provider returning a non-SessionManager instance yields RUN_ERROR
        with SESSION_MANAGER_INVALID_TYPE code, rather than silently passing
        garbage into Strands."""
        # Common footgun: provider returns the class instead of an instance.
        def bad_provider(_input_data):
            return "not-a-session-manager"

        agent = _make_base_agent(session_manager_provider=bad_provider)

        with patch("ag_ui_strands.agent.StrandsAgentCore") as MockCore:
            events = await _collect_events(agent, _make_run_input())

        MockCore.assert_not_called()
        error_event = next(e for e in events if e.type == EventType.RUN_ERROR)
        assert error_event.code == "SESSION_MANAGER_INVALID_TYPE"
        assert "str" in error_event.message  # the actual type is reported
        assert EventType.RUN_FINISHED not in [e.type for e in events]

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

    @pytest.mark.asyncio
    async def test_private_session_manager_disables_replay_history(self):
        mock_session_manager = _mock_session_manager()
        provider = MagicMock(return_value=mock_session_manager)
        agent = _make_base_agent(session_manager_provider=provider)
        input_data = _make_run_input(
            messages=[UserMessage(id="u1", content="hello from user")]
        )

        instance = _MockStrandsAgentWithPrivateSessionManager(mock_session_manager)
        with patch("ag_ui_strands.agent.StrandsAgentCore") as MockCore:
            MockCore.return_value = instance
            await _collect_events(agent, input_data)

        assert instance.stream_prompts == ["hello from user"]
        assert not hasattr(instance, "messages")


class _MockSessionAgentWithHistory:
    """Session-manager-backed mock that records ``stream_async`` prompts and
    exposes a native Strands ``messages`` history (as a real session manager
    would). ``replay_history_into_strands`` is suppressed when a session
    manager is present, so this exercises the legacy
    ``stream_async(user_message)`` path."""

    def __init__(self, session_manager, messages=None):
        self._session_manager = session_manager
        self.messages = messages if messages is not None else []
        self.tool_registry = MagicMock()
        self.tool_registry.registry = {}
        self.stream_prompts = []

    async def stream_async(self, prompt):
        self.stream_prompts.append(prompt)
        return
        yield  # pragma: no cover


def _delta_continuation_input(tools):
    """A delta-only continuation payload: just the trailing ``tool`` result,
    with NO preceding assistant message carrying ``tool_calls`` (mirrors what
    CopilotKit sends after a void-handler frontend tool resolves)."""
    return RunAgentInput(
        thread_id="thread-delta",
        run_id="run-2",
        state={},
        messages=[
            ToolMessage(id="t1", role="tool", content="", tool_call_id="call-xyz"),
        ],
        tools=tools,
        context=[],
        forwarded_props={},
    )


def _frontend_tool(name: str) -> Tool:
    return Tool(name=name, description=f"{name} tool", parameters={})


class TestFrontendToolContinuation:
    """Regression tests for the 'Hello' injection on delta-only frontend-tool
    continuation runs (PR #1761)."""

    @pytest.mark.asyncio
    async def test_delta_only_continuation_does_not_inject_hello(self):
        """Session-manager path + delta-only trailing tool message + missing
        assistant tool_calls: ``stream_async`` must NOT receive ``"Hello"``,
        and must not guess an arbitrary frontend tool when several exist."""
        mock_session_manager = _mock_session_manager()
        provider = MagicMock(return_value=mock_session_manager)
        agent = _make_base_agent(session_manager_provider=provider)

        # Multiple frontend tools — the old code would arbitrarily pick one.
        tools = [_frontend_tool("setBackground"), _frontend_tool("setForeground")]
        input_data = _delta_continuation_input(tools)

        # No session history that resolves call-xyz → name is unresolvable.
        instance = _MockSessionAgentWithHistory(mock_session_manager, messages=[])
        with patch("ag_ui_strands.agent.StrandsAgentCore") as MockCore:
            MockCore.return_value = instance
            await _collect_events(agent, input_data)

        assert instance.stream_prompts == [""]
        assert "Hello" not in instance.stream_prompts
        # No arbitrary frontend tool name leaked into the prompt.
        assert not any(
            "executed successfully" in (p or "") for p in instance.stream_prompts
        )

    @pytest.mark.asyncio
    async def test_delta_only_continuation_resolves_name_from_session_history(self):
        """When the assistant ``tool_calls`` message is absent from the delta
        payload but present in the session's native history, the correct tool
        name is recovered (not an arbitrary one)."""
        mock_session_manager = _mock_session_manager()
        provider = MagicMock(return_value=mock_session_manager)
        agent = _make_base_agent(session_manager_provider=provider)

        tools = [_frontend_tool("setBackground"), _frontend_tool("setForeground")]
        input_data = _delta_continuation_input(tools)

        # Native Strands history holds the toolUse that owns call-xyz.
        session_history = [
            {"role": "user", "content": [{"text": "make it blue"}]},
            {
                "role": "assistant",
                "content": [
                    {
                        "toolUse": {
                            "toolUseId": "call-xyz",
                            "name": "setBackground",
                            "input": {"color": "blue"},
                        }
                    }
                ],
            },
        ]
        instance = _MockSessionAgentWithHistory(
            mock_session_manager, messages=session_history
        )
        with patch("ag_ui_strands.agent.StrandsAgentCore") as MockCore:
            MockCore.return_value = instance
            await _collect_events(agent, input_data)

        assert instance.stream_prompts == [
            "setBackground executed successfully with no return value."
        ]
        assert "Hello" not in instance.stream_prompts

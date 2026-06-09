"""Tests for the sync-only run feature.

Any run that arrives with an empty message list (``input.messages == []``)
short-circuits before the LLM.  ``ADKAgent.run()`` must:
  - emit RUN_STARTED + RUN_FINISHED without calling the LLM
  - emit STATE_SNAPSHOT with the session's current state (internal keys
    stripped)
  - emit MESSAGES_SNAPSHOT when ``emit_messages_snapshot=True`` and the
    session has events that convert to messages
  - create the session if it does not exist yet (same as a normal run)
  - not append events to the session (read-only)

Two callers hit this path:
  1. Framework "connect" calls (e.g. CopilotKit connectAgent) which fire on
     every mount with an empty message list to check thread state.
  2. Explicit history-restore triggers on thread switches (e.g. ThreadsPanel
     calling runAgent with no messages so the backend emits a snapshot).
"""

import pytest
import uuid
from unittest.mock import AsyncMock, patch

from ag_ui.core import EventType, RunAgentInput, UserMessage
from google.adk.agents import Agent
from google.adk.sessions import InMemorySessionService
from google.adk.events import Event
from google.genai import types as genai_types

from ag_ui_adk import ADKAgent
from ag_ui_adk.session_manager import (
    SessionManager,
    THREAD_ID_STATE_KEY,
    APP_NAME_STATE_KEY,
    USER_ID_STATE_KEY,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_input(
    thread_id: str = "thread-1",
    messages: list | None = None,
    forwarded_props: dict | None = None,
) -> RunAgentInput:
    return RunAgentInput(
        thread_id=thread_id,
        run_id=str(uuid.uuid4()),
        messages=messages or [],
        state={},
        context=[],
        tools=[],
        forwarded_props=forwarded_props or {},
    )


def _make_agent() -> Agent:
    return Agent(name="test_agent", instruction="You are a test assistant.")


async def _collect(gen) -> list:
    events = []
    async for event in gen:
        events.append(event)
    return events


def _event_types(events: list) -> list[str]:
    return [e.type for e in events]


def _text_adk_event(author: str, text: str) -> Event:
    return Event(
        author=author,
        content=genai_types.Content(
            role="user" if author == "user" else "model",
            parts=[genai_types.Part(text=text)],
        ),
        invocation_id=str(uuid.uuid4()),
    )


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def reset_session_manager():
    SessionManager.reset_instance()
    yield
    SessionManager.reset_instance()


@pytest.fixture
def session_service():
    return InMemorySessionService()


@pytest.fixture
def adk_agent(session_service):
    return ADKAgent(
        adk_agent=_make_agent(),
        app_name="test_app",
        user_id="test_user",
        session_service=session_service,
        use_thread_id_as_session_id=True,
    )


@pytest.fixture
def adk_agent_with_snapshot(session_service):
    return ADKAgent(
        adk_agent=_make_agent(),
        app_name="test_app",
        user_id="test_user",
        session_service=session_service,
        use_thread_id_as_session_id=True,
        emit_messages_snapshot=True,
    )


# ---------------------------------------------------------------------------
# Trigger: empty vs non-empty messages
# ---------------------------------------------------------------------------

class TestSyncOnlyTrigger:

    @pytest.mark.asyncio
    async def test_empty_messages_triggers_sync(self, adk_agent):
        """Empty message list → sync-only path (no LLM call)."""
        inp = _make_input(messages=[])
        with patch(
            "ag_ui_adk.adk_agent.Runner.run_async",
            new_callable=AsyncMock,
        ) as mock_run:
            events = await _collect(adk_agent.run(inp))
        mock_run.assert_not_called()
        assert events[0].type == EventType.RUN_STARTED
        assert events[-1].type == EventType.RUN_FINISHED

    @pytest.mark.asyncio
    async def test_non_empty_messages_does_not_trigger_sync(self, adk_agent):
        """Non-empty message list → normal run path (LLM may be called)."""
        inp = _make_input(
            messages=[UserMessage(id="m1", role="user", content="hello")]
        )
        async def _empty_gen(*_, **__):
            return
            yield  # make it an async generator

        with patch("ag_ui_adk.adk_agent.Runner.run_async", _empty_gen):
            events = await _collect(adk_agent.run(inp))
        # Sync-only path was not taken — no MESSAGES_SNAPSHOT from a snapshot.
        assert not any(
            e.type == EventType.MESSAGES_SNAPSHOT for e in events
        )

    @pytest.mark.asyncio
    async def test_forwarded_props_irrelevant_to_trigger(self, adk_agent):
        """forwardedProps do not affect the trigger — only messages matter."""
        inp = _make_input(
            messages=[],
            forwarded_props={"some_key": "some_value"},
        )
        with patch(
            "ag_ui_adk.adk_agent.Runner.run_async",
            new_callable=AsyncMock,
        ) as mock_run:
            events = await _collect(adk_agent.run(inp))
        mock_run.assert_not_called()
        assert events[-1].type == EventType.RUN_FINISHED


# ---------------------------------------------------------------------------
# Core event sequence
# ---------------------------------------------------------------------------

class TestSyncOnlyEventSequence:

    @pytest.mark.asyncio
    async def test_emits_run_started_and_run_finished(self, adk_agent):
        inp = _make_input()
        events = await _collect(adk_agent.run(inp))
        types = _event_types(events)
        assert EventType.RUN_STARTED in types
        assert EventType.RUN_FINISHED in types

    @pytest.mark.asyncio
    async def test_run_started_is_first_event(self, adk_agent):
        inp = _make_input()
        events = await _collect(adk_agent.run(inp))
        assert events[0].type == EventType.RUN_STARTED

    @pytest.mark.asyncio
    async def test_run_finished_is_last_event(self, adk_agent):
        inp = _make_input()
        events = await _collect(adk_agent.run(inp))
        assert events[-1].type == EventType.RUN_FINISHED

    @pytest.mark.asyncio
    async def test_no_text_message_events(self, adk_agent):
        """LLM is never called, so no text message events should appear."""
        inp = _make_input()
        events = await _collect(adk_agent.run(inp))
        text_types = {
            EventType.TEXT_MESSAGE_START,
            EventType.TEXT_MESSAGE_CONTENT,
            EventType.TEXT_MESSAGE_END,
        }
        assert not any(e.type in text_types for e in events)

    @pytest.mark.asyncio
    async def test_no_tool_call_events(self, adk_agent):
        """LLM is never called, so no tool call events should appear."""
        inp = _make_input()
        events = await _collect(adk_agent.run(inp))
        tool_types = {EventType.TOOL_CALL_START, EventType.TOOL_CALL_END}
        assert not any(e.type in tool_types for e in events)

    @pytest.mark.asyncio
    async def test_run_error_not_emitted_on_success(self, adk_agent):
        inp = _make_input()
        events = await _collect(adk_agent.run(inp))
        assert not any(e.type == EventType.RUN_ERROR for e in events)

    @pytest.mark.asyncio
    async def test_thread_and_run_ids_are_propagated(self, adk_agent):
        inp = _make_input(thread_id="my-thread")
        events = await _collect(adk_agent.run(inp))
        started = next(e for e in events if e.type == EventType.RUN_STARTED)
        finished = next(e for e in events if e.type == EventType.RUN_FINISHED)
        assert started.thread_id == "my-thread"
        assert started.run_id == inp.run_id
        assert finished.thread_id == "my-thread"
        assert finished.run_id == inp.run_id


# ---------------------------------------------------------------------------
# State snapshot
# ---------------------------------------------------------------------------

class TestSyncOnlyStateSnapshot:

    @pytest.mark.asyncio
    async def test_emits_state_snapshot_when_session_has_state(
        self, adk_agent, session_service
    ):
        await session_service.create_session(
            app_name="test_app",
            user_id="test_user",
            session_id="thread-state",
            state={"story": "A user story"},
        )
        inp = _make_input(thread_id="thread-state")
        events = await _collect(adk_agent.run(inp))
        snapshots = [e for e in events if e.type == EventType.STATE_SNAPSHOT]
        assert len(snapshots) == 1
        assert snapshots[0].snapshot["story"] == "A user story"

    @pytest.mark.asyncio
    async def test_state_snapshot_strips_internal_keys(
        self, adk_agent, session_service
    ):
        await session_service.create_session(
            app_name="test_app",
            user_id="test_user",
            session_id="thread-internal",
            state={
                "story": "hello",
                THREAD_ID_STATE_KEY: "thread-internal",
                APP_NAME_STATE_KEY: "test_app",
                USER_ID_STATE_KEY: "test_user",
            },
        )
        inp = _make_input(thread_id="thread-internal")
        events = await _collect(adk_agent.run(inp))
        snapshots = [e for e in events if e.type == EventType.STATE_SNAPSHOT]
        assert len(snapshots) == 1
        snap = snapshots[0].snapshot
        assert "story" in snap
        assert THREAD_ID_STATE_KEY not in snap
        assert APP_NAME_STATE_KEY not in snap
        assert USER_ID_STATE_KEY not in snap

    @pytest.mark.asyncio
    async def test_no_state_snapshot_when_state_is_empty(self, adk_agent):
        inp = _make_input(thread_id="thread-empty")
        events = await _collect(adk_agent.run(inp))
        snapshots = [e for e in events if e.type == EventType.STATE_SNAPSHOT]
        assert len(snapshots) == 0


# ---------------------------------------------------------------------------
# Messages snapshot
# ---------------------------------------------------------------------------

class TestSyncOnlyMessagesSnapshot:

    @pytest.mark.asyncio
    async def test_no_messages_snapshot_when_flag_disabled(
        self, adk_agent, session_service
    ):
        """emit_messages_snapshot=False (default) → no MESSAGES_SNAPSHOT."""
        await session_service.create_session(
            app_name="test_app",
            user_id="test_user",
            session_id="thread-no-snap",
        )
        inp = _make_input(thread_id="thread-no-snap")
        events = await _collect(adk_agent.run(inp))
        assert not any(
            e.type == EventType.MESSAGES_SNAPSHOT for e in events
        )

    @pytest.mark.asyncio
    async def test_emits_messages_snapshot_when_flag_enabled(
        self, adk_agent_with_snapshot, session_service
    ):
        """emit_messages_snapshot=True + events → MESSAGES_SNAPSHOT."""
        session = await session_service.create_session(
            app_name="test_app",
            user_id="test_user",
            session_id="thread-snap",
        )
        await session_service.append_event(
            session, _text_adk_event("user", "hello")
        )
        await session_service.append_event(
            session, _text_adk_event("test_agent", "hi there")
        )

        inp = _make_input(thread_id="thread-snap")
        events = await _collect(adk_agent_with_snapshot.run(inp))
        snapshots = [
            e for e in events if e.type == EventType.MESSAGES_SNAPSHOT
        ]
        assert len(snapshots) == 1
        assert len(snapshots[0].messages) >= 1

    @pytest.mark.asyncio
    async def test_messages_snapshot_content(
        self, adk_agent_with_snapshot, session_service
    ):
        """Snapshot messages match the stored session events."""
        session = await session_service.create_session(
            app_name="test_app",
            user_id="test_user",
            session_id="thread-content",
        )
        await session_service.append_event(
            session, _text_adk_event("user", "what is the story?")
        )

        inp = _make_input(thread_id="thread-content")
        events = await _collect(adk_agent_with_snapshot.run(inp))
        snap = next(
            e for e in events if e.type == EventType.MESSAGES_SNAPSHOT
        )
        user_msgs = [
            m for m in snap.messages if getattr(m, "role", None) == "user"
        ]
        assert any(
            "story" in (getattr(m, "content", "") or "")
            for m in user_msgs
        )

    @pytest.mark.asyncio
    async def test_no_messages_snapshot_for_empty_session(
        self, adk_agent_with_snapshot
    ):
        """New session with no events → no MESSAGES_SNAPSHOT even with flag."""
        inp = _make_input(thread_id="thread-brand-new")
        events = await _collect(adk_agent_with_snapshot.run(inp))
        assert not any(
            e.type == EventType.MESSAGES_SNAPSHOT for e in events
        )


# ---------------------------------------------------------------------------
# LLM is never called
# ---------------------------------------------------------------------------

class TestSyncOnlyNoLlmCall:

    @pytest.mark.asyncio
    async def test_runner_run_async_not_called(self, adk_agent):
        """Runner.run_async must not be invoked during a sync-only run."""
        inp = _make_input()
        with patch(
            "ag_ui_adk.adk_agent.Runner.run_async",
            new_callable=AsyncMock,
        ) as mock_run:
            await _collect(adk_agent.run(inp))
        mock_run.assert_not_called()


# ---------------------------------------------------------------------------
# Session lifecycle
# ---------------------------------------------------------------------------

class TestSyncOnlySessionLifecycle:

    @pytest.mark.asyncio
    async def test_creates_session_if_not_exists(
        self, adk_agent, session_service
    ):
        """Sync-only run for a new thread_id creates a session."""
        thread_id = "thread-new-" + str(uuid.uuid4())
        inp = _make_input(thread_id=thread_id)
        events = await _collect(adk_agent.run(inp))
        assert events[-1].type == EventType.RUN_FINISHED

        session = await session_service.get_session(
            app_name="test_app",
            user_id="test_user",
            session_id=thread_id,
        )
        assert session is not None

    @pytest.mark.asyncio
    async def test_does_not_append_events_to_session(
        self, adk_agent, session_service
    ):
        """Sync-only run must not append events to the session."""
        await session_service.create_session(
            app_name="test_app",
            user_id="test_user",
            session_id="thread-unmodified",
            state={"story": "original"},
        )
        before = await session_service.get_session(
            app_name="test_app",
            user_id="test_user",
            session_id="thread-unmodified",
        )
        initial_count = len(before.events)

        inp = _make_input(thread_id="thread-unmodified")
        await _collect(adk_agent.run(inp))

        after = await session_service.get_session(
            app_name="test_app",
            user_id="test_user",
            session_id="thread-unmodified",
        )
        assert len(after.events) == initial_count
        assert after.state.get("story") == "original"

"""Integration tests for ADKAgent.from_app() constructor.

Requires GOOGLE_API_KEY environment variable to be set.
"""
import asyncio
import os
import pytest
import uuid
from ag_ui.core import EventType, RunAgentInput, UserMessage
from ag_ui_adk import ADKAgent
from ag_ui_adk.session_manager import SessionManager
from google.adk.apps import App
from google.adk.agents import LlmAgent

pytestmark = pytest.mark.skipif(
    not os.environ.get("GOOGLE_API_KEY"),
    reason="GOOGLE_API_KEY environment variable not set"
)


@pytest.fixture
def sample_app():
    """Create a simple App for testing."""
    agent = LlmAgent(
        name="test_agent",
        model="gemini-2.0-flash",
        instruction="You are a helpful assistant. Keep responses brief.",
    )
    return App(name="test_app", root_agent=agent)


@pytest.fixture(autouse=True)
def reset_session_manager():
    """Reset session manager between tests."""
    yield
    SessionManager._instance = None


@pytest.mark.asyncio
async def test_from_app_basic_conversation(sample_app):
    """Test that from_app() creates a working agent."""
    adk_agent = ADKAgent.from_app(sample_app, user_id="test_user")

    input_data = RunAgentInput(
        thread_id=f"test_thread_{uuid.uuid4().hex[:8]}",
        run_id=f"test_run_{uuid.uuid4().hex[:8]}",
        messages=[UserMessage(id="msg1", content="Say hello in one word")],
        state={},
        tools=[],
        context=[],
        forwarded_props={},
    )

    events = []
    async for event in adk_agent.run(input_data):
        events.append(event)

    # Verify we got expected event types
    event_types = [e.type for e in events]
    assert EventType.RUN_STARTED in event_types
    assert EventType.RUN_FINISHED in event_types


@pytest.mark.asyncio
async def test_from_app_preserves_app_name(sample_app):
    """Test that app.name is used correctly."""
    adk_agent = ADKAgent.from_app(sample_app, user_id="test_user")
    assert adk_agent._static_app_name == "test_app"


@pytest.mark.asyncio
async def test_from_app_stores_app_reference(sample_app):
    """Test that the App is stored for per-request use."""
    adk_agent = ADKAgent.from_app(sample_app, user_id="test_user")
    assert adk_agent._app is sample_app


@pytest.mark.asyncio
async def test_from_app_with_custom_timeout():
    """Test that plugin_close_timeout is stored correctly."""
    agent = LlmAgent(
        name="test_agent",
        model="gemini-2.0-flash",
        instruction="You are helpful.",
    )
    app = App(name="test_app", root_agent=agent)

    adk_agent = ADKAgent.from_app(
        app,
        user_id="test_user",
        plugin_close_timeout=15.0,
    )

    assert adk_agent._plugin_close_timeout == 15.0


@pytest.mark.asyncio
async def test_from_app_type_validation():
    """Test that from_app() validates the app parameter type."""
    with pytest.raises(TypeError, match="Expected App instance"):
        ADKAgent.from_app("not an app", user_id="test_user")


@pytest.mark.asyncio
async def test_from_app_extracts_root_agent(sample_app):
    """Test that root_agent is correctly extracted from App."""
    adk_agent = ADKAgent.from_app(sample_app, user_id="test_user")
    assert adk_agent._adk_agent is sample_app.root_agent


@pytest.mark.asyncio
async def test_from_app_multi_turn_conversation(sample_app):
    """Test multi-turn conversation with from_app()."""
    adk_agent = ADKAgent.from_app(sample_app, user_id="test_user")
    thread_id = f"test_thread_{uuid.uuid4().hex[:8]}"

    # First turn
    input1 = RunAgentInput(
        thread_id=thread_id,
        run_id=f"run1_{uuid.uuid4().hex[:8]}",
        messages=[UserMessage(id="msg1", content="My name is Alice")],
        state={},
        tools=[],
        context=[],
        forwarded_props={},
    )

    events1 = []
    async for event in adk_agent.run(input1):
        events1.append(event)

    assert any(e.type == EventType.RUN_FINISHED for e in events1)

    # Second turn - should maintain context
    input2 = RunAgentInput(
        thread_id=thread_id,
        run_id=f"run2_{uuid.uuid4().hex[:8]}",
        messages=[
            UserMessage(id="msg1", content="My name is Alice"),
            UserMessage(id="msg2", content="What is my name?"),
        ],
        state={},
        tools=[],
        context=[],
        forwarded_props={},
    )

    events2 = []
    async for event in adk_agent.run(input2):
        events2.append(event)

    assert any(e.type == EventType.RUN_FINISHED for e in events2)


@pytest.mark.asyncio
async def test_runner_supports_plugin_close_timeout():
    """Test that runtime detection of plugin_close_timeout works."""
    agent = LlmAgent(
        name="test_agent",
        model="gemini-2.0-flash",
        instruction="You are helpful.",
    )
    app = App(name="test_app", root_agent=agent)
    adk_agent = ADKAgent.from_app(app, user_id="test_user")

    # This should return True or False based on ADK version
    result = adk_agent._runner_supports_plugin_close_timeout()
    assert isinstance(result, bool)

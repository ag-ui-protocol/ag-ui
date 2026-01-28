"""Pytest configuration and shared fixtures for Claude Agent SDK tests."""

import os
import pytest
from pathlib import Path
from unittest.mock import Mock, MagicMock, AsyncMock
from types import SimpleNamespace

# Load environment variables from .env.local if it exists
try:
    from dotenv import load_dotenv
    
    # Get the project root directory (integrations/claude-agent-sdk/python)
    project_root = Path(__file__).parent.parent
    
    # Try to load .env.local first, then fall back to .env
    env_local = project_root / ".env.local"
    env_file = project_root / ".env"
    
    if env_local.exists():
        load_dotenv(env_local, override=True)
        print(f"Loaded environment variables from {env_local}")
    elif env_file.exists():
        load_dotenv(env_file, override=True)
        print(f"Loaded environment variables from {env_file}")
except ImportError:
    # python-dotenv not installed, skip loading
    pass

try:
    from ag_ui.core import RunAgentInput, UserMessage, Tool as AGUITool
except ImportError:
    pass

try:
    from claude_agent_sdk import (
        ClaudeSDKClient,
        ClaudeAgentOptions,
        AssistantMessage,
        TextBlock,
        ToolUseBlock,
        ResultMessage,
    )
except ImportError:
    # Type checking fallback
    pass


@pytest.fixture(autouse=True)
def reset_session_manager():
    """Reset session manager before and after each test."""
    from ag_ui_claude.session_manager import SessionManager
    
    try:
        SessionManager.reset_instance()
    except (RuntimeError, AttributeError):
        # Event loop may be closed or instance not initialized - ignore
        pass
    
    yield
    
    # Cleanup after test
    try:
        SessionManager.reset_instance()
    except (RuntimeError, AttributeError):
        pass


@pytest.fixture
def mock_claude_sdk_client():
    """Create a mock ClaudeSDKClient."""
    client = AsyncMock(spec=ClaudeSDKClient)
    
    # Mock the query method
    async def mock_query(prompt: str):
        pass
    
    # Mock the receive_response method
    async def mock_receive_response():
        # Return empty generator by default
        if False:
            yield
    
    client.query = AsyncMock(side_effect=mock_query)
    client.receive_response = AsyncMock(side_effect=mock_receive_response)
    
    return client


@pytest.fixture
def mock_claude_agent_options():
    """Create a mock ClaudeAgentOptions."""
    options = Mock(spec=ClaudeAgentOptions)
    options.system_prompt = None
    options.permission_mode = None
    options.allowed_tools = None
    options.mcp_servers = None
    return options


@pytest.fixture
def sample_run_agent_input():
    """Create a sample RunAgentInput for testing."""
    return RunAgentInput(
        thread_id="test_thread_001",
        run_id="test_run_001",
        messages=[
            UserMessage(
                id="msg_1",
                role="user",
                content="Hello, Claude!"
            )
        ],
        state={},
        context=[],
        tools=[],
        forwarded_props={}
    )


@pytest.fixture
def sample_ag_ui_tool():
    """Create a sample AG-UI Tool for testing."""
    return AGUITool(
        name="get_weather",
        description="Get the current weather",
        parameters={
            "type": "object",
            "properties": {
                "location": {
                    "type": "string",
                    "description": "The city and state"
                }
            },
            "required": ["location"]
        }
    )


@pytest.fixture
def mock_assistant_message_with_text():
    """Create a mock AssistantMessage with TextBlock."""
    text_block = SimpleNamespace()
    text_block.text = "Hello! How can I help you?"
    
    # Create a class that mimics AssistantMessage
    class MockAssistantMessage:
        def __init__(self):
            self.content = [text_block]
    
    message = MockAssistantMessage()
    return message


@pytest.fixture
def mock_assistant_message_with_tool():
    """Create a mock AssistantMessage with ToolUseBlock."""
    tool_block = SimpleNamespace()
    tool_block.id = "tool_call_123"
    tool_block.name = "get_weather"
    tool_block.input = {"location": "San Francisco"}
    
    class MockAssistantMessage:
        def __init__(self):
            self.content = [tool_block]
    
    message = MockAssistantMessage()
    return message


@pytest.fixture
def mock_result_message_success():
    """Create a mock ResultMessage indicating success."""
    class MockResultMessage:
        def __init__(self):
            self.subtype = "success"
    
    message = MockResultMessage()
    return message


@pytest.fixture
def mock_result_message_error():
    """Create a mock ResultMessage indicating error."""
    class MockResultMessage:
        def __init__(self):
            self.subtype = "error"
    
    message = MockResultMessage()
    return message


@pytest.fixture
def claude_agent_persistent():
    """Create a ClaudeAgent instance with persistent sessions."""
    from ag_ui_claude import ClaudeAgent
    
    return ClaudeAgent(
        use_persistent_sessions=True,
        app_name="test_app",
        user_id="test_user",
        execution_timeout_seconds=60,
        max_concurrent_executions=5
    )


@pytest.fixture
def claude_agent_stateless():
    """Create a ClaudeAgent instance with stateless mode."""
    from ag_ui_claude import ClaudeAgent
    
    return ClaudeAgent(
        use_persistent_sessions=False,
        app_name="test_app",
        user_id="test_user",
        execution_timeout_seconds=60,
        max_concurrent_executions=5
    )


"""
Tests for Flowise Agent
"""

import pytest
from unittest.mock import Mock, patch
from ag_ui_flowise.flowise_agent import FlowiseAgent, FlowiseAgentConfig


def test_flowise_agent_initialization():
    """Test FlowiseAgent initialization"""
    config = FlowiseAgentConfig(
        api_url="http://localhost:3000/api/v1/prediction/{flowId}",
        flow_id="test-flow-id"
    )
    
    agent = FlowiseAgent(config)
    
    assert agent.config == config
    assert agent.api_url == "http://localhost:3000/api/v1/prediction/test-flow-id"


def test_flowise_agent_clone():
    """Test FlowiseAgent clone method"""
    config = FlowiseAgentConfig(
        api_url="http://localhost:3000/api/v1/prediction/{flowId}",
        flow_id="test-flow-id"
    )
    
    agent = FlowiseAgent(config)
    cloned_agent = agent.clone()
    
    assert isinstance(cloned_agent, FlowiseAgent)
    assert cloned_agent.config == config


@patch('ag_ui_flowise.flowise_agent.requests.post')
def test_flowise_agent_run(mock_post):
    """Test FlowiseAgent run method"""
    # Mock the response
    mock_response = Mock()
    mock_response.json.return_value = {
        'text': 'Hello from Flowise!',
        'question': 'Hello'
    }
    mock_response.raise_for_status.return_value = None
    mock_post.return_value = mock_response
    
    config = FlowiseAgentConfig(
        api_url="http://localhost:3000/api/v1/prediction/{flowId}",
        flow_id="test-flow-id"
    )
    
    agent = FlowiseAgent(config)
    
    input_data = {
        'threadId': 'test-thread-id',
        'runId': 'test-run-id',
        'messages': [
            {
                'id': '1',
                'role': 'user',
                'content': 'Hello'
            }
        ]
    }
    
    events = agent.run(input_data)
    
    # Check that we got the expected events
    assert len(events) == 5  # RunStarted, TextMessageStart, TextMessageContent, TextMessageEnd, RunFinished, MessagesSnapshot
    
    # Verify the mock was called correctly
    mock_post.assert_called_once()
    args, kwargs = mock_post.call_args
    assert args[0] == "http://localhost:3000/api/v1/prediction/test-flow-id"
    assert kwargs['json']['question'] == 'Hello'
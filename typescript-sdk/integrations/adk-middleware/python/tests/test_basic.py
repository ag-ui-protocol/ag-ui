#!/usr/bin/env python
"""Basic test to verify ADK setup works."""

import pytest
from google.adk.agents import Agent
from google.adk import Runner
from ag_ui_adk import ADKAgent


def test_google_adk_imports():
    """Test that Google ADK imports work correctly."""
    # If we got here, imports were successful
    assert Agent is not None
    assert Runner is not None


def test_adk_middleware_imports():
    """Test that ADK middleware imports work correctly."""
    # If we got here, imports were successful
    assert ADKAgent is not None


def test_agent_creation():
    """Test that we can create ADK agents."""
    agent = Agent(
        name="test_agent",
        instruction="You are a test agent."
    )
    assert agent.name == "test_agent"
    assert "test agent" in agent.instruction.lower()


def test_adk_agent_creation():
    """Test ADKAgent creation with direct agent embedding."""
    # Create test agent
    agent = Agent(
        name="test_agent",
        instruction="You are a test agent."
    )

    # Create ADKAgent with the test agent
    adk_agent = ADKAgent(
        adk_agent=agent,
        app_name="test_app",
        user_id="test_user",
        use_in_memory_services=True
    )
    assert adk_agent._adk_agent.name == "test_agent"


def test_adk_middleware_creation():
    """Test that ADK middleware can be created."""
    # Create test agent first
    agent = Agent(name="middleware_test_agent", instruction="Test agent.")

    adk_agent = ADKAgent(
        adk_agent=agent,
        app_name="test_app",
        user_id="test",
        use_in_memory_services=True,
    )
    assert adk_agent is not None
    assert adk_agent._static_app_name == "test_app"
    assert adk_agent._static_user_id == "test"


def test_full_integration():
    """Test full integration of components."""
    # Create agent
    agent = Agent(
        name="integration_test_agent",
        instruction="You are a test agent for integration testing."
    )

    # Create middleware with direct agent embedding
    adk_agent = ADKAgent(
        adk_agent=agent,
        app_name="integration_test_app",
        user_id="integration_test_user",
        use_in_memory_services=True,
    )

    # Verify components work together
    assert adk_agent._adk_agent.name == "integration_test_agent"
    assert adk_agent._static_app_name == "integration_test_app"
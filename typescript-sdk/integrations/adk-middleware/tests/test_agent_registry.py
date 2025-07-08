#!/usr/bin/env python
"""Tests for AgentRegistry singleton."""

import pytest
from unittest.mock import MagicMock, patch

from adk_middleware.agent_registry import AgentRegistry
from google.adk.agents import BaseAgent


class TestAgentRegistry:
    """Tests for AgentRegistry singleton functionality."""
    
    @pytest.fixture(autouse=True)
    def reset_registry(self):
        """Reset registry singleton before each test."""
        AgentRegistry.reset_instance()
        yield
        AgentRegistry.reset_instance()
    
    @pytest.fixture
    def mock_agent(self):
        """Create a mock BaseAgent."""
        agent = MagicMock(spec=BaseAgent)
        agent.name = "test_agent"
        return agent
    
    @pytest.fixture
    def second_mock_agent(self):
        """Create a second mock BaseAgent."""
        agent = MagicMock(spec=BaseAgent)
        agent.name = "second_agent"
        return agent
    
    def test_singleton_behavior(self):
        """Test that AgentRegistry is a singleton."""
        registry1 = AgentRegistry.get_instance()
        registry2 = AgentRegistry.get_instance()
        
        assert registry1 is registry2
        assert isinstance(registry1, AgentRegistry)
    
    @patch('adk_middleware.agent_registry.logger')
    def test_singleton_initialization_logging(self, mock_logger):
        """Test that singleton initialization is logged."""
        AgentRegistry.get_instance()
        
        mock_logger.info.assert_called_once_with("Initialized AgentRegistry singleton")
    
    def test_reset_instance(self):
        """Test that reset_instance clears the singleton."""
        registry1 = AgentRegistry.get_instance()
        AgentRegistry.reset_instance()
        registry2 = AgentRegistry.get_instance()
        
        assert registry1 is not registry2
    
    def test_register_agent_basic(self, mock_agent):
        """Test registering a basic agent."""
        registry = AgentRegistry.get_instance()
        
        registry.register_agent("test_id", mock_agent)
        
        retrieved_agent = registry.get_agent("test_id")
        assert retrieved_agent is mock_agent
    
    @patch('adk_middleware.agent_registry.logger')
    def test_register_agent_logging(self, mock_logger, mock_agent):
        """Test that agent registration is logged."""
        registry = AgentRegistry.get_instance()
        
        registry.register_agent("test_id", mock_agent)
        
        mock_logger.info.assert_called_with("Registered agent 'test_agent' with ID 'test_id'")
    
    def test_register_agent_invalid_type(self):
        """Test that registering non-BaseAgent raises TypeError."""
        registry = AgentRegistry.get_instance()
        
        with pytest.raises(TypeError, match="Agent must be an instance of BaseAgent"):
            registry.register_agent("test_id", "not_an_agent")
    
    def test_register_multiple_agents(self, mock_agent, second_mock_agent):
        """Test registering multiple agents."""
        registry = AgentRegistry.get_instance()
        
        registry.register_agent("agent1", mock_agent)
        registry.register_agent("agent2", second_mock_agent)
        
        assert registry.get_agent("agent1") is mock_agent
        assert registry.get_agent("agent2") is second_mock_agent
    
    def test_register_agent_overwrite(self, mock_agent, second_mock_agent):
        """Test that registering with same ID overwrites previous agent."""
        registry = AgentRegistry.get_instance()
        
        registry.register_agent("test_id", mock_agent)
        registry.register_agent("test_id", second_mock_agent)
        
        assert registry.get_agent("test_id") is second_mock_agent
    
    def test_unregister_agent_success(self, mock_agent):
        """Test successful agent unregistration."""
        registry = AgentRegistry.get_instance()
        
        registry.register_agent("test_id", mock_agent)
        unregistered_agent = registry.unregister_agent("test_id")
        
        assert unregistered_agent is mock_agent
        
        # Should raise ValueError when trying to get unregistered agent
        with pytest.raises(ValueError, match="No agent found for ID 'test_id'"):
            registry.get_agent("test_id")
    
    def test_unregister_agent_not_found(self):
        """Test unregistering non-existent agent returns None."""
        registry = AgentRegistry.get_instance()
        
        result = registry.unregister_agent("nonexistent")
        
        assert result is None
    
    @patch('adk_middleware.agent_registry.logger')
    def test_unregister_agent_logging(self, mock_logger, mock_agent):
        """Test that agent unregistration is logged."""
        registry = AgentRegistry.get_instance()
        
        registry.register_agent("test_id", mock_agent)
        registry.unregister_agent("test_id")
        
        # Should log singleton initialization, registration, and unregistration
        assert mock_logger.info.call_count == 3
        mock_logger.info.assert_any_call("Unregistered agent with ID 'test_id'")
    
    def test_set_default_agent(self, mock_agent):
        """Test setting default agent."""
        registry = AgentRegistry.get_instance()
        
        registry.set_default_agent(mock_agent)
        
        # Should be able to get any agent ID using the default
        retrieved_agent = registry.get_agent("any_id")
        assert retrieved_agent is mock_agent
    
    @patch('adk_middleware.agent_registry.logger')
    def test_set_default_agent_logging(self, mock_logger, mock_agent):
        """Test that setting default agent is logged."""
        registry = AgentRegistry.get_instance()
        
        registry.set_default_agent(mock_agent)
        
        mock_logger.info.assert_called_with("Set default agent to 'test_agent'")
    
    def test_set_default_agent_invalid_type(self):
        """Test that setting non-BaseAgent as default raises TypeError."""
        registry = AgentRegistry.get_instance()
        
        with pytest.raises(TypeError, match="Agent must be an instance of BaseAgent"):
            registry.set_default_agent("not_an_agent")
    
    def test_set_agent_factory(self, mock_agent):
        """Test setting agent factory function."""
        registry = AgentRegistry.get_instance()
        
        def factory(agent_id):
            return mock_agent
        
        registry.set_agent_factory(factory)
        
        # Should use factory for unknown agent IDs
        retrieved_agent = registry.get_agent("unknown_id")
        assert retrieved_agent is mock_agent
    
    @patch('adk_middleware.agent_registry.logger')
    def test_set_agent_factory_logging(self, mock_logger):
        """Test that setting agent factory is logged."""
        registry = AgentRegistry.get_instance()
        
        def factory(agent_id):
            return MagicMock(spec=BaseAgent)
        
        registry.set_agent_factory(factory)
        
        mock_logger.info.assert_called_with("Set agent factory function")
    
    def test_get_agent_resolution_order(self, mock_agent, second_mock_agent):
        """Test agent resolution order: registry -> factory -> default -> error."""
        registry = AgentRegistry.get_instance()
        
        # Set up all resolution mechanisms
        registry.register_agent("registered_id", mock_agent)
        registry.set_default_agent(second_mock_agent)
        
        factory_agent = MagicMock(spec=BaseAgent)
        factory_agent.name = "factory_agent"
        
        def factory(agent_id):
            if agent_id == "factory_id":
                return factory_agent
            raise ValueError("Factory doesn't handle this ID")
        
        registry.set_agent_factory(factory)
        
        # Test resolution order
        assert registry.get_agent("registered_id") is mock_agent  # Registry first
        assert registry.get_agent("factory_id") is factory_agent  # Factory second
        assert registry.get_agent("unregistered_id") is second_mock_agent  # Default third
    
    @patch('adk_middleware.agent_registry.logger')
    def test_get_agent_registered_logging(self, mock_logger, mock_agent):
        """Test logging when getting registered agent."""
        registry = AgentRegistry.get_instance()
        
        registry.register_agent("test_id", mock_agent)
        registry.get_agent("test_id")
        
        mock_logger.debug.assert_called_with("Found registered agent for ID 'test_id'")
    
    @patch('adk_middleware.agent_registry.logger')
    def test_get_agent_factory_success_logging(self, mock_logger):
        """Test logging when factory successfully creates agent."""
        registry = AgentRegistry.get_instance()
        
        factory_agent = MagicMock(spec=BaseAgent)
        factory_agent.name = "factory_agent"
        
        def factory(agent_id):
            return factory_agent
        
        registry.set_agent_factory(factory)
        registry.get_agent("factory_id")
        
        mock_logger.info.assert_called_with("Created agent via factory for ID 'factory_id'")
    
    @patch('adk_middleware.agent_registry.logger')
    def test_get_agent_factory_invalid_return_logging(self, mock_logger):
        """Test logging when factory returns invalid agent."""
        registry = AgentRegistry.get_instance()
        
        def factory(agent_id):
            return "not_an_agent"
        
        registry.set_agent_factory(factory)
        
        with pytest.raises(ValueError, match="No agent found for ID"):
            registry.get_agent("factory_id")
        
        mock_logger.warning.assert_called_with(
            "Factory returned non-BaseAgent for ID 'factory_id': <class 'str'>"
        )
    
    @patch('adk_middleware.agent_registry.logger')
    def test_get_agent_factory_exception_logging(self, mock_logger):
        """Test logging when factory raises exception."""
        registry = AgentRegistry.get_instance()
        
        def factory(agent_id):
            raise RuntimeError("Factory error")
        
        registry.set_agent_factory(factory)
        
        with pytest.raises(ValueError, match="No agent found for ID"):
            registry.get_agent("factory_id")
        
        mock_logger.error.assert_called_with("Factory failed for agent ID 'factory_id': Factory error")
    
    @patch('adk_middleware.agent_registry.logger')
    def test_get_agent_default_logging(self, mock_logger, mock_agent):
        """Test logging when using default agent."""
        registry = AgentRegistry.get_instance()
        
        registry.set_default_agent(mock_agent)
        registry.get_agent("unknown_id")
        
        mock_logger.debug.assert_called_with("Using default agent for ID 'unknown_id'")
    
    def test_get_agent_no_resolution_error(self):
        """Test error when no agent can be resolved."""
        registry = AgentRegistry.get_instance()
        
        with pytest.raises(ValueError) as exc_info:
            registry.get_agent("unknown_id")
        
        error_msg = str(exc_info.value)
        assert "No agent found for ID 'unknown_id'" in error_msg
        assert "Registered IDs: []" in error_msg
        assert "Default agent: not set" in error_msg
        assert "Factory: not set" in error_msg
    
    def test_get_agent_error_with_registered_agents(self, mock_agent):
        """Test error message includes registered agent IDs."""
        registry = AgentRegistry.get_instance()
        
        registry.register_agent("agent1", mock_agent)
        registry.register_agent("agent2", mock_agent)
        
        with pytest.raises(ValueError) as exc_info:
            registry.get_agent("unknown_id")
        
        error_msg = str(exc_info.value)
        assert "Registered IDs: ['agent1', 'agent2']" in error_msg
    
    def test_get_agent_error_with_default_agent(self, mock_agent):
        """Test error message indicates default agent is set."""
        registry = AgentRegistry.get_instance()
        
        registry.set_default_agent(mock_agent)
        
        # This should not raise an error since default is set
        retrieved_agent = registry.get_agent("unknown_id")
        assert retrieved_agent is mock_agent
    
    def test_get_agent_error_with_factory(self):
        """Test error message indicates factory is set."""
        registry = AgentRegistry.get_instance()
        
        def factory(agent_id):
            raise ValueError("Factory doesn't handle this ID")
        
        registry.set_agent_factory(factory)
        
        with pytest.raises(ValueError) as exc_info:
            registry.get_agent("unknown_id")
        
        error_msg = str(exc_info.value)
        assert "Factory: set" in error_msg
    
    def test_has_agent_registered(self, mock_agent):
        """Test has_agent returns True for registered agent."""
        registry = AgentRegistry.get_instance()
        
        registry.register_agent("test_id", mock_agent)
        
        assert registry.has_agent("test_id") is True
    
    def test_has_agent_factory(self, mock_agent):
        """Test has_agent returns True for factory-created agent."""
        registry = AgentRegistry.get_instance()
        
        def factory(agent_id):
            return mock_agent
        
        registry.set_agent_factory(factory)
        
        assert registry.has_agent("factory_id") is True
    
    def test_has_agent_default(self, mock_agent):
        """Test has_agent returns True for default agent."""
        registry = AgentRegistry.get_instance()
        
        registry.set_default_agent(mock_agent)
        
        assert registry.has_agent("any_id") is True
    
    def test_has_agent_not_found(self):
        """Test has_agent returns False when no agent can be resolved."""
        registry = AgentRegistry.get_instance()
        
        assert registry.has_agent("unknown_id") is False
    
    def test_list_registered_agents_empty(self):
        """Test listing registered agents when none are registered."""
        registry = AgentRegistry.get_instance()
        
        result = registry.list_registered_agents()
        
        assert result == {}
    
    def test_list_registered_agents_with_agents(self, mock_agent, second_mock_agent):
        """Test listing registered agents."""
        registry = AgentRegistry.get_instance()
        
        registry.register_agent("agent1", mock_agent)
        registry.register_agent("agent2", second_mock_agent)
        
        result = registry.list_registered_agents()
        
        assert result == {
            "agent1": "test_agent",
            "agent2": "second_agent"
        }
    
    def test_list_registered_agents_excludes_default(self, mock_agent, second_mock_agent):
        """Test that list_registered_agents excludes default agent."""
        registry = AgentRegistry.get_instance()
        
        registry.register_agent("registered", mock_agent)
        registry.set_default_agent(second_mock_agent)
        
        result = registry.list_registered_agents()
        
        assert result == {"registered": "test_agent"}
    
    def test_clear_agents(self, mock_agent):
        """Test clearing all agents and settings."""
        registry = AgentRegistry.get_instance()
        
        # Set up registry with various configurations
        registry.register_agent("test_id", mock_agent)
        registry.set_default_agent(mock_agent)
        registry.set_agent_factory(lambda x: mock_agent)
        
        # Clear everything
        registry.clear()
        
        # Should have no registered agents
        assert registry.list_registered_agents() == {}
        
        # Should have no default agent or factory
        with pytest.raises(ValueError, match="No agent found for ID"):
            registry.get_agent("test_id")
    
    @patch('adk_middleware.agent_registry.logger')
    def test_clear_agents_logging(self, mock_logger, mock_agent):
        """Test that clearing agents is logged."""
        registry = AgentRegistry.get_instance()
        
        registry.register_agent("test_id", mock_agent)
        registry.clear()
        
        mock_logger.info.assert_any_call("Cleared all agents from registry")
    
    def test_multiple_singleton_instances_share_state(self, mock_agent):
        """Test that multiple singleton instances share state."""
        registry1 = AgentRegistry.get_instance()
        registry2 = AgentRegistry.get_instance()
        
        registry1.register_agent("test_id", mock_agent)
        
        # Should be accessible from both instances
        assert registry2.get_agent("test_id") is mock_agent
        assert registry1.has_agent("test_id") is True
        assert registry2.has_agent("test_id") is True
    
    def test_factory_precedence_over_default(self, mock_agent, second_mock_agent):
        """Test that factory takes precedence over default agent."""
        registry = AgentRegistry.get_instance()
        
        # Set both factory and default
        registry.set_default_agent(second_mock_agent)
        
        def factory(agent_id):
            if agent_id == "factory_id":
                return mock_agent
            raise ValueError("Factory doesn't handle this ID")
        
        registry.set_agent_factory(factory)
        
        # Factory should be used for factory_id
        assert registry.get_agent("factory_id") is mock_agent
        
        # Default should be used for other IDs
        assert registry.get_agent("other_id") is second_mock_agent
    
    def test_registry_precedence_over_factory(self, mock_agent, second_mock_agent):
        """Test that registered agent takes precedence over factory."""
        registry = AgentRegistry.get_instance()
        
        # Register an agent
        registry.register_agent("test_id", mock_agent)
        
        # Set factory that would return a different agent
        def factory(agent_id):
            return second_mock_agent
        
        registry.set_agent_factory(factory)
        
        # Registered agent should take precedence
        assert registry.get_agent("test_id") is mock_agent
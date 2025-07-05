    # src/agent_registry.py

"""Singleton registry for mapping AG-UI agent IDs to ADK agents."""

from typing import Dict, Optional, Callable
from google.adk.agents import BaseAgent
import logging

logger = logging.getLogger(__name__)


class AgentRegistry:
    """Singleton registry for mapping AG-UI agent IDs to ADK agents.
    
    This registry provides a centralized location for managing the mapping
    between AG-UI agent identifiers and Google ADK agent instances.
    """
    
    _instance = None
    
    def __init__(self):
        """Initialize the registry.
        
        Note: Use get_instance() instead of direct instantiation.
        """
        self._registry: Dict[str, BaseAgent] = {}
        self._default_agent: Optional[BaseAgent] = None
        self._agent_factory: Optional[Callable[[str], BaseAgent]] = None
    
    @classmethod
    def get_instance(cls) -> 'AgentRegistry':
        """Get the singleton instance of AgentRegistry.
        
        Returns:
            The singleton AgentRegistry instance
        """
        if cls._instance is None:
            cls._instance = cls()
            logger.info("Initialized AgentRegistry singleton")
        return cls._instance
    
    @classmethod
    def reset_instance(cls):
        """Reset the singleton instance (mainly for testing)."""
        cls._instance = None
    
    def register_agent(self, agent_id: str, agent: BaseAgent):
        """Register an ADK agent for a specific AG-UI agent ID.
        
        Args:
            agent_id: The AG-UI agent identifier
            agent: The ADK agent instance to register
        """
        if not isinstance(agent, BaseAgent):
            raise TypeError(f"Agent must be an instance of BaseAgent, got {type(agent)}")
        
        self._registry[agent_id] = agent
        logger.info(f"Registered agent '{agent.name}' with ID '{agent_id}'")
    
    def unregister_agent(self, agent_id: str) -> Optional[BaseAgent]:
        """Unregister an agent by ID.
        
        Args:
            agent_id: The AG-UI agent identifier to unregister
            
        Returns:
            The unregistered agent if found, None otherwise
        """
        agent = self._registry.pop(agent_id, None)
        if agent:
            logger.info(f"Unregistered agent with ID '{agent_id}'")
        return agent
    
    def set_default_agent(self, agent: BaseAgent):
        """Set the fallback agent for unregistered agent IDs.
        
        Args:
            agent: The default ADK agent to use when no specific mapping exists
        """
        if not isinstance(agent, BaseAgent):
            raise TypeError(f"Agent must be an instance of BaseAgent, got {type(agent)}")
        
        self._default_agent = agent
        logger.info(f"Set default agent to '{agent.name}'")
    
    def set_agent_factory(self, factory: Callable[[str], BaseAgent]):
        """Set a factory function for dynamic agent creation.
        
        The factory will be called with the agent_id when no registered
        agent is found and before falling back to the default agent.
        
        Args:
            factory: A callable that takes an agent_id and returns a BaseAgent
        """
        self._agent_factory = factory
        logger.info("Set agent factory function")
    
    def get_agent(self, agent_id: str) -> BaseAgent:
        """Resolve an ADK agent from an AG-UI agent ID.
        
        Resolution order:
        1. Check registry for exact match
        2. Call factory if provided
        3. Use default agent
        4. Raise error
        
        Args:
            agent_id: The AG-UI agent identifier
            
        Returns:
            The resolved ADK agent
            
        Raises:
            ValueError: If no agent can be resolved for the given ID
        """
        # 1. Check registry
        if agent_id in self._registry:
            logger.debug(f"Found registered agent for ID '{agent_id}'")
            return self._registry[agent_id]
        
        # 2. Try factory
        if self._agent_factory:
            try:
                agent = self._agent_factory(agent_id)
                if isinstance(agent, BaseAgent):
                    logger.info(f"Created agent via factory for ID '{agent_id}'")
                    return agent
                else:
                    logger.warning(f"Factory returned non-BaseAgent for ID '{agent_id}': {type(agent)}")
            except Exception as e:
                logger.error(f"Factory failed for agent ID '{agent_id}': {e}")
        
        # 3. Use default
        if self._default_agent:
            logger.debug(f"Using default agent for ID '{agent_id}'")
            return self._default_agent
        
        # 4. No agent found
        registered_ids = list(self._registry.keys())
        raise ValueError(
            f"No agent found for ID '{agent_id}'. "
            f"Registered IDs: {registered_ids}. "
            f"Default agent: {'set' if self._default_agent else 'not set'}. "
            f"Factory: {'set' if self._agent_factory else 'not set'}"
        )
    
    def has_agent(self, agent_id: str) -> bool:
        """Check if an agent can be resolved for the given ID.
        
        Args:
            agent_id: The AG-UI agent identifier
            
        Returns:
            True if an agent can be resolved, False otherwise
        """
        try:
            self.get_agent(agent_id)
            return True
        except ValueError:
            return False
    
    def list_registered_agents(self) -> Dict[str, str]:
        """List all registered agents.
        
        Returns:
            A dictionary mapping agent IDs to agent names
        """
        return {
            agent_id: agent.name 
            for agent_id, agent in self._registry.items()
        }
    
    def clear(self):
        """Clear all registered agents and settings."""
        self._registry.clear()
        self._default_agent = None
        self._agent_factory = None
        logger.info("Cleared all agents from registry")
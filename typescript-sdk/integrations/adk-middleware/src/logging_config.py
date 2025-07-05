#!/usr/bin/env python3
"""Configurable logging for ADK middleware components."""

import logging
import os
from typing import Dict, Optional

# Module-level logger for this config module itself
_module_logger = logging.getLogger(__name__)
_module_logger.setLevel(logging.INFO)
if not _module_logger.handlers:
    _handler = logging.StreamHandler()
    _formatter = logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s')
    _handler.setFormatter(_formatter)
    _module_logger.addHandler(_handler)

class ComponentLogger:
    """Manages logging levels for different middleware components."""
    
    # Component names and their default levels
    COMPONENTS = {
        'event_translator': 'WARNING',    # Event translation logic
        'endpoint': 'WARNING',           # HTTP endpoint responses  
        'raw_response': 'WARNING',       # Raw ADK responses
        'llm_response': 'WARNING',       # LLM response processing
        'adk_agent': 'INFO',            # Main agent logic (keep some info)
        'session_manager': 'WARNING',    # Session management
        'agent_registry': 'WARNING',     # Agent registration
    }
    
    def __init__(self):
        """Initialize component loggers with configurable levels."""
        self._loggers: Dict[str, logging.Logger] = {}
        self._setup_loggers()
    
    def _setup_loggers(self):
        """Set up individual loggers for each component."""
        for component, default_level in self.COMPONENTS.items():
            # Check for environment variable override
            env_var = f"ADK_LOG_{component.upper()}"
            level = os.getenv(env_var, default_level).upper()
            
            # Create logger
            logger = logging.getLogger(component)
            logger.setLevel(getattr(logging, level, logging.WARNING))
            
            # Prevent propagation to avoid duplicate messages
            logger.propagate = False
            
            # Add handler if it doesn't have one
            if not logger.handlers:
                handler = logging.StreamHandler()
                formatter = logging.Formatter(
                    '%(asctime)s - %(name)s - %(levelname)s - %(message)s'
                )
                handler.setFormatter(formatter)
                logger.addHandler(handler)
            
            self._loggers[component] = logger
    
    def get_logger(self, component: str) -> logging.Logger:
        """Get logger for a specific component."""
        if component not in self._loggers:
            # Create a default logger for unknown components
            logger = logging.getLogger(component)
            logger.setLevel(logging.WARNING)
            self._loggers[component] = logger
        return self._loggers[component]
    
    def set_level(self, component: str, level: str):
        """Set logging level for a specific component at runtime."""
        if component in self._loggers:
            logger = self._loggers[component]
            logger.setLevel(getattr(logging, level.upper(), logging.WARNING))
            _module_logger.info(f"Set {component} logging to {level.upper()}")
        else:
            _module_logger.warning(f"Unknown component: {component}")
    
    def enable_debug_mode(self, components: Optional[list] = None):
        """Enable debug logging for specific components or all."""
        if components is None:
            components = list(self.COMPONENTS.keys())
        
        for component in components:
            if component in self._loggers:
                self.set_level(component, 'DEBUG')
    
    def disable_all(self):
        """Disable all component logging (set to ERROR level)."""
        for component in self._loggers:
            self.set_level(component, 'ERROR')
    
    def show_status(self):
        """Show current logging levels for all components."""
        _module_logger.info("ADK Middleware Logging Status:")
        _module_logger.info("=" * 40)
        for component, logger in self._loggers.items():
            level_name = logging.getLevelName(logger.level)
            env_var = f"ADK_LOG_{component.upper()}"
            env_value = os.getenv(env_var, "default")
            _module_logger.info(f"  {component:<18}: {level_name:<8} (env: {env_value})")


# Global instance
_component_logger = ComponentLogger()

def get_component_logger(component: str) -> logging.Logger:
    """Get logger for a specific component."""
    return _component_logger.get_logger(component)

def configure_logging(
    event_translator: str = None,
    endpoint: str = None, 
    raw_response: str = None,
    llm_response: str = None,
    adk_agent: str = None,
    session_manager: str = None,
    agent_registry: str = None
):
    """Configure logging levels for multiple components at once."""
    config = {
        'event_translator': event_translator,
        'endpoint': endpoint,
        'raw_response': raw_response, 
        'llm_response': llm_response,
        'adk_agent': adk_agent,
        'session_manager': session_manager,
        'agent_registry': agent_registry,
    }
    
    for component, level in config.items():
        if level is not None:
            _component_logger.set_level(component, level)

def show_logging_help():
    """Show help for configuring logging."""
    help_text = """
ADK Middleware Logging Configuration
======================================

Environment Variables:
  ADK_LOG_EVENT_TRANSLATOR=DEBUG|INFO|WARNING|ERROR
  ADK_LOG_ENDPOINT=DEBUG|INFO|WARNING|ERROR  
  ADK_LOG_RAW_RESPONSE=DEBUG|INFO|WARNING|ERROR
  ADK_LOG_LLM_RESPONSE=DEBUG|INFO|WARNING|ERROR
  ADK_LOG_ADK_AGENT=DEBUG|INFO|WARNING|ERROR
  ADK_LOG_SESSION_MANAGER=DEBUG|INFO|WARNING|ERROR
  ADK_LOG_AGENT_REGISTRY=DEBUG|INFO|WARNING|ERROR

Python API:
  from src.logging_config import configure_logging
  
  # Enable specific debugging
  configure_logging(event_translator='DEBUG', endpoint='DEBUG')
  
  # Disable verbose logging
  configure_logging(raw_response='ERROR', llm_response='ERROR')

Examples:
  # Debug event translation only
  export ADK_LOG_EVENT_TRANSLATOR=DEBUG
  
  # Quiet everything except errors  
  export ADK_LOG_EVENT_TRANSLATOR=ERROR
  export ADK_LOG_ENDPOINT=ERROR
  export ADK_LOG_RAW_RESPONSE=ERROR
  export ADK_LOG_LLM_RESPONSE=ERROR
"""
    _module_logger.info(help_text)

if __name__ == "__main__":
    # Show current status and help
    _component_logger.show_status()
    show_logging_help()
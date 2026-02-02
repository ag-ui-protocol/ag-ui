"""AG-UI OpenResponses Integration.

This package provides an AG-UI agent that connects to any
OpenResponses-compatible endpoint, including OpenAI, Azure OpenAI,
Hugging Face, and OpenClaw.
"""

from .agent import OpenResponsesAgent
from .config_loader import list_configs, load_config
from .endpoint import create_openresponses_endpoint, create_openresponses_proxy
from .providers import Provider, detect_provider, get_provider, get_provider_defaults
from .types import (
    AzureProviderConfig,
    OpenClawProviderConfig,
    OpenResponsesAgentConfig,
    ProviderType,
    fill_runtime_config,
    merge_runtime_config,
)

__all__ = [
    # Main class
    "OpenResponsesAgent",
    # Endpoint factories
    "create_openresponses_endpoint",
    "create_openresponses_proxy",
    # Config loader
    "load_config",
    "list_configs",
    # Configuration
    "OpenResponsesAgentConfig",
    "OpenClawProviderConfig",
    "AzureProviderConfig",
    "ProviderType",
    # Utilities
    "Provider",
    "detect_provider",
    "get_provider",
    "get_provider_defaults",
    "fill_runtime_config",
    "merge_runtime_config",
]

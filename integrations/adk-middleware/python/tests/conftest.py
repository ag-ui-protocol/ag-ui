"""Shared pytest fixtures for ADK middleware tests."""

from __future__ import annotations

import pytest

from ag_ui.core import SystemMessage as CoreSystemMessage

import ag_ui_adk.adk_agent as adk_agent_module


@pytest.fixture(autouse=True)
def restore_system_message_class():
    """Ensure every test starts and ends with the real SystemMessage type."""

    adk_agent_module.SystemMessage = CoreSystemMessage
    try:
        yield
    finally:
        adk_agent_module.SystemMessage = CoreSystemMessage

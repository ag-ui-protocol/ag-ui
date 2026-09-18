"""Agentic chat agent configuration."""

from typing import Any

from ag_ui_copilot_sdk import CopilotAgent


def create_agentic_chat_agent(client: Any) -> CopilotAgent:
    """Create the agent for agentic chat."""
    return CopilotAgent(
        client,
        name="agentic_chat",
        model="gpt-5.4-mini",
        instructions="You are a helpful assistant. Use declared tools when requested.",
        session_options={
            # Keep the demo hermetic: no repo config, skills, hooks, or git access.
            "enable_config_discovery": False,
            "enable_on_demand_instruction_discovery": False,
            "enable_file_hooks": False,
            "enable_host_git_operations": False,
            "enable_session_store": False,
            "enable_skills": False,
        },
    )

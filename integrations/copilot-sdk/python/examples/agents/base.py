"""Shared defaults for the example agents."""

import os
from typing import Any

from ag_ui_copilot_sdk import CopilotAgent

# Keep the demos hermetic: no repo config, skills, hooks, or git access.
HERMETIC = {
    "enable_config_discovery": False,
    "enable_on_demand_instruction_discovery": False,
    "enable_file_hooks": False,
    "enable_host_git_operations": False,
    "enable_session_store": False,
    "enable_skills": False,
}


def define_agent(
    client: Any, *, session_options: dict[str, Any] | None = None, **kwargs: Any
) -> CopilotAgent:
    return CopilotAgent(
        client,
        model=os.getenv("COPILOT_MODEL", "gpt-5.4-mini"),
        session_options={**HERMETIC, **(session_options or {})},
        **kwargs,
    )

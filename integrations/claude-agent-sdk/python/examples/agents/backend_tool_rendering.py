"""
Backend tool rendering agent configuration.

This module demonstrates how to create an agent with backend-defined MCP tools.
The tools are rendered in the AG-UI frontend when the agent uses them.
"""

import json
from typing import Any
from claude_agent_sdk import tool, create_sdk_mcp_server
from ag_ui_claude_sdk import ClaudeAgentAdapter
from .constants import DEFAULT_DISALLOWED_TOOLS


@tool("get_weather", "Get current weather for a location", {"location": str})
async def get_weather(args: dict[str, Any]) -> dict[str, Any]:
    """Mock weather tool that returns sample weather data."""
    weather_data = {
        "temperature": 20,
        "conditions": "sunny",
        "humidity": 50,
        "wind_speed": 10,
        "feels_like": 25,
    }
    
    return {
        "content": [{"type": "text", "text": json.dumps(weather_data)}],
        **weather_data
    }


# Create MCP server with weather tool
weather_server = create_sdk_mcp_server("weather", "1.0.0", tools=[get_weather])


def create_backend_tool_adapter() -> ClaudeAgentAdapter:
    """Create adapter for backend tool rendering demo."""
    return ClaudeAgentAdapter(
        name="backend_tool_rendering",
        description="Weather assistant with backend MCP tools",
        options={
            "model": "claude-haiku-4-5",
            "system_prompt": "You are a helpful weather assistant. When users ask about weather, use the get_weather tool.",
            "mcp_servers": {"weather": weather_server},
            "allowed_tools": ["mcp__weather__get_weather"],
            "disallowed_tools": list(DEFAULT_DISALLOWED_TOOLS),
        }
    )




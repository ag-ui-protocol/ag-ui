"""
Backend tool rendering agent configuration.

This module demonstrates how to create an agent with backend-defined MCP tools.
The tools are rendered in the AG-UI frontend when the agent uses them.
"""

import json
from typing import Any
from claude_agent_sdk import tool, create_sdk_mcp_server
from ag_ui_claude_sdk import ClaudeAgentAdapter


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


def create_backend_tool_adapter(cwd: str) -> ClaudeAgentAdapter:
    """
    Create adapter for backend tool rendering demo.
    
    Args:
        cwd: Working directory for conversation state (per-thread).
        
    Returns:
        Configured ClaudeAgentAdapter with weather MCP tool.
    """
    return ClaudeAgentAdapter(
        model="claude-haiku-4-5",
        cwd=cwd,
        system_prompt="You are a helpful weather assistant. When users ask about weather, use the get_weather tool.",
        mcp_servers={"weather": weather_server},
        allowed_tools=["mcp__weather__get_weather"],
    )




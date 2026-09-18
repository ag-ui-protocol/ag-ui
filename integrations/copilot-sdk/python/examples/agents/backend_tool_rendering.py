"""A server-side tool; the Dojo renders its call and result as a weather card."""

from typing import Any

from ag_ui_copilot_sdk import AGUITool, CopilotAgent, ToolContext

from .base import define_agent


def get_weather(args: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
    return {
        "temperature": 20,
        "conditions": "sunny",
        "humidity": 50,
        "windSpeed": 10,
        "feelsLike": 25,
    }


def create_backend_tool_rendering_agent(client: Any) -> CopilotAgent:
    return define_agent(
        client,
        name="backend_tool_rendering",
        instructions=(
            "You are a helpful Weather Assistant. Always call the get_weather tool to "
            "look up the weather before you answer."
        ),
        tools=[
            AGUITool(
                name="get_weather",
                skip_permission=True,
                description="Get current weather for a location",
                parameters={
                    "type": "object",
                    "properties": {
                        "location": {"type": "string", "description": "City or location name"}
                    },
                    "required": ["location"],
                },
                handler=get_weather,
            )
        ],
    )

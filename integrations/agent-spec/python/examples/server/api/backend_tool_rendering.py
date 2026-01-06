from __future__ import annotations

import os
import time
from typing import Dict, Any

import dotenv
dotenv.load_dotenv()

from pyagentspec.agent import Agent
from pyagentspec.llms import OpenAiCompatibleConfig
from pyagentspec.tools import ServerTool
from pyagentspec.property import Property
from pyagentspec.serialization import AgentSpecSerializer


def get_weather(location: str) -> Dict[str, Any]:
    """
    Get the weather for a given location.
    """
    time.sleep(1)  # simulates real tool execution
    return {
        "temperature": 20,
        "conditions": "sunny",
        "humidity": 50,
        "wind_speed": 10,
        "feelsLike": 25,
    }

tool_input_property = Property(
    title="location",
    json_schema={"title": "location", "type": "string", "description": "The location to get the weather forecast. Must be a city/town name."},
)

weather_result_property = Property(
    title="weather_result",
    json_schema={
        "title": "weather_result",
        "type": "string"
    },
)

weather_tool = ServerTool(
    name="get_weather",
    description="Get the weather for a given location.",
    inputs=[tool_input_property],
    outputs=[weather_result_property],
)

agent_llm = OpenAiCompatibleConfig(
    name="my_llm",
    model_id=os.environ.get("OPENAI_MODEL", "gpt-4o"),
    url=os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1")
)

agent = Agent(
    name="my_agent",
    llm_config=agent_llm,
    system_prompt="Based on the weather forecaset result and the user input, write a response to the user",
    tools=[weather_tool],
    human_in_the_loop=True,
)

backend_tool_rendering_agent_json = AgentSpecSerializer().to_json(agent)

tool_registry = {"get_weather": get_weather}

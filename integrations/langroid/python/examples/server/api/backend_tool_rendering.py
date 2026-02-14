"""Backend Tool Rendering example for Langroid.

This example shows an agent with backend tool rendering capabilities.
Backend tools are executed on the server side, and the results are returned to the agent.
"""
import json
import os
import random
from pathlib import Path
from dotenv import load_dotenv

env_path = Path(__file__).parent.parent.parent / '.env'
load_dotenv(dotenv_path=env_path)

import langroid as lr
from langroid.agent import ToolMessage, ChatAgent
from ag_ui_langroid import LangroidAgent, create_langroid_app


class GetWeatherTool(ToolMessage):
    """Get weather information for a location."""
    request: str = "get_weather"
    purpose: str = """
        Get current weather information for a specific location.
        Use this when the user asks about weather conditions.
    """
    location: str

class RenderChartTool(ToolMessage):
    """Render a chart with backend processing."""
    request: str = "render_chart"
    purpose: str = """
        Render a chart with backend processing capabilities.
        Use this when the user wants to visualize data in a chart format.
    """
    chart_type: str
    data: str


llm_config = lr.language_models.OpenAIGPTConfig(
    chat_model=lr.language_models.OpenAIChatModel.GPT4o,
    api_key=os.getenv("OPENAI_API_KEY"),
    # Make behavior deterministic for demos and e2e tests
    temperature=0.0,
)



agent_config = lr.ChatAgentConfig(
    name="WeatherAssistant",
    llm=llm_config,
    system_message="""You are a helpful assistant with backend tool rendering capabilities.
    You can get weather information and render charts.

    CRITICAL RULES:
    - When the user asks about the weather for a specific location, you MUST call the `get_weather` tool EXACTLY ONCE.
    - Do NOT answer with current weather details unless you have first called `get_weather` and used the returned JSON.
    - When describing weather data, use the EXACT values from the tool result (temperature, conditions, humidity, wind speed, feels_like, location).
    - Never tell the user you are going to fetch or retrieve weather data without actually calling the `get_weather` tool.
    - When the user asks to visualize or chart data, you MUST call the `render_chart` tool to generate the chart metadata.
    - After calling a tool, provide a brief natural-language summary that is fully consistent with the tool result.
    """,
    use_tools=True,
    use_functions_api=False,
)


class WeatherAssistantAgent(ChatAgent):
    """ChatAgent with backend tool handlers."""
    
    def get_weather(self, msg: GetWeatherTool) -> str:
        """Handle get_weather tool execution. Returns JSON string with weather data."""
        location = msg.location
        conditions_list = ["sunny", "cloudy", "rainy", "clear", "partly cloudy"]
        result = {
            "temperature": random.randint(60, 85),
            "conditions": random.choice(conditions_list),
            "humidity": random.randint(30, 80),
            "wind_speed": random.randint(5, 20),
            "feels_like": random.randint(58, 88),
            "location": location
        }
        return json.dumps(result)
    
    def render_chart(self, msg: RenderChartTool) -> str:
        """Handle render_chart tool execution. Returns JSON string with chart data."""
        chart_type = msg.chart_type
        data = msg.data
        result = {
            "chart_type": chart_type,
            "data_preview": data[:100] if len(data) > 100 else data,
            "status": "rendered",
            "message": f"Successfully rendered {chart_type} chart"
        }
        return json.dumps(result)


chat_agent = WeatherAssistantAgent(agent_config)
chat_agent.enable_message(GetWeatherTool)
chat_agent.enable_message(RenderChartTool)

task = lr.Task(
    chat_agent,
    name="WeatherAssistant",
    interactive=False,
    single_round=False,
)

agui_agent = LangroidAgent(
    agent=task,
    name="backend_tool_rendering",
    description="Langroid agent with backend tool rendering support - weather and chart rendering",
)

app = create_langroid_app(agui_agent, "/")


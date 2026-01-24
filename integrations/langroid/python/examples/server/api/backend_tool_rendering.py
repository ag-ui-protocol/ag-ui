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
)



agent_config = lr.ChatAgentConfig(
    name="WeatherAssistant",
    llm=llm_config,
    system_message="""You are a helpful assistant with backend tool rendering capabilities. 
    You can get weather information and render charts. 
    Always use the appropriate tools when users ask about weather or want to visualize data.
    IMPORTANT: When describing weather data, use the EXACT values from the tool result. 
    Do not make up or estimate values - quote the precise temperature, conditions, humidity, and wind speed from the tool result.""",
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


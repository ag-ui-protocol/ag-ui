"""Backend Tool Rendering example for AWS Strands.

This example shows an agent with backend tool rendering capabilities.
The change_background tool is registered here so the LLM knows about it,
but the actual execution happens on the frontend via useFrontendTool.
"""
import os
from pathlib import Path
from dotenv import load_dotenv

# Suppress OpenTelemetry context warnings from Strands SDK
os.environ["OTEL_SDK_DISABLED"] = "true"
os.environ["OTEL_PYTHON_DISABLED_INSTRUMENTATIONS"] = "all"

from strands import Agent, tool
from strands.models.openai import OpenAIModel
from ag_ui_strands import StrandsAgent, create_strands_app

# Load environment variables from .env file
env_path = Path(__file__).parent.parent.parent / '.env'

load_dotenv(dotenv_path=env_path)

# Use OpenAI model (routed to LLMock via OPENAI_BASE_URL)
model = OpenAIModel(
    client_args={
        "api_key": os.getenv("OPENAI_API_KEY", "sk-mock"),
    },
    model_id="gpt-4o",
    params={
        "temperature": 0.7,
        "max_tokens": 2048,
    }
)

# Define backend tools for demonstration
@tool
def render_chart(chart_type: str, data: str) -> dict:
    """
    Render a chart with backend processing capabilities.
    
    Args:
        chart_type: Type of chart (bar, line, pie, etc.)
        data: Chart data in JSON format
    
    Returns:
        Chart data for frontend rendering
    """
    return {
        "chart_type": chart_type,
        "data": data[:100],
        "status": "rendered"
    }

@tool
def get_weather(location: str) -> dict:
    """
    Get weather information for a location.
    
    Args:
        location: The location to get weather for
    
    Returns:
        Weather data with temperature, conditions, humidity, wind speed
    """
    import random
    
    # Simulate different weather conditions
    conditions_list = ["sunny", "cloudy", "rainy", "clear", "partly cloudy"]
    
    return {
        "temperature": random.randint(60, 85),
        "conditions": random.choice(conditions_list),
        "humidity": random.randint(30, 80),
        "wind_speed": random.randint(5, 20),
        "feels_like": random.randint(58, 88)
    }

strands_agent = Agent(
    model=model,
    tools=[get_weather, render_chart],
    system_prompt="You are a helpful assistant with backend tool rendering capabilities. You can get weather information and render charts.",
)

agui_agent = StrandsAgent(
    agent=strands_agent,
    name="backend_tool_rendering",
    description="AWS Strands agent with backend tool rendering support",
)

app = create_strands_app(agui_agent, "/")


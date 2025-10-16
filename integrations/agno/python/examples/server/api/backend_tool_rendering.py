"""Example: Agno Agent with Finance tools

This example shows how to create an Agno Agent with tools (YFinanceTools) and expose it in an AG-UI compatible way.
"""

from agno.agent.agent import Agent
from agno.app.agui.app import AGUIApp
from agno.models.openai import OpenAIChat
from agno.tools.yfinance import YFinanceTools
from agno.tools import tool
import httpx
import json


def get_weather_condition(code: int) -> str:
    """Map weather code to human-readable condition.

    Args:
        code: WMO weather code.

    Returns:
        Human-readable weather condition string.
    """
    conditions = {
        0: "Clear sky",
        1: "Mainly clear",
        2: "Partly cloudy",
        3: "Overcast",
        45: "Foggy",
        48: "Depositing rime fog",
        51: "Light drizzle",
        53: "Moderate drizzle",
        55: "Dense drizzle",
        56: "Light freezing drizzle",
        57: "Dense freezing drizzle",
        61: "Slight rain",
        63: "Moderate rain",
        65: "Heavy rain",
        66: "Light freezing rain",
        67: "Heavy freezing rain",
        71: "Slight snow fall",
        73: "Moderate snow fall",
        75: "Heavy snow fall",
        77: "Snow grains",
        80: "Slight rain showers",
        81: "Moderate rain showers",
        82: "Violent rain showers",
        85: "Slight snow showers",
        86: "Heavy snow showers",
        95: "Thunderstorm",
        96: "Thunderstorm with slight hail",
        99: "Thunderstorm with heavy hail",
    }
    return conditions.get(code, "Unknown")


@tool(external_execution=False)
async def get_weather(location: str) -> str:
    """Get current weather for a location.

    Args:
        location: City name.

    Returns:
        A json string with weather information including temperature, feels like,
        humidity, wind speed, wind gust, conditions, and location name.
    """
    async with httpx.AsyncClient() as client:
        # Geocode the location
        geocoding_url = (
            f"https://geocoding-api.open-meteo.com/v1/search?name={location}&count=1"
        )
        geocoding_response = await client.get(geocoding_url)
        geocoding_data = geocoding_response.json()

        if not geocoding_data.get("results"):
            raise ValueError(f"Location '{location}' not found")

        result = geocoding_data["results"][0]
        latitude = result["latitude"]
        longitude = result["longitude"]
        name = result["name"]

        # Get weather data
        weather_url = (
            f"https://api.open-meteo.com/v1/forecast?"
            f"latitude={latitude}&longitude={longitude}"
            f"&current=temperature_2m,apparent_temperature,relative_humidity_2m,"
            f"wind_speed_10m,wind_gusts_10m,weather_code"
        )
        weather_response = await client.get(weather_url)
        weather_data = weather_response.json()

        current = weather_data["current"]

        return json.dumps(
            {
                "temperature": current["temperature_2m"],
                "feelsLike": current["apparent_temperature"],
                "humidity": current["relative_humidity_2m"],
                "windSpeed": current["wind_speed_10m"],
                "windGust": current["wind_gusts_10m"],
                "conditions": get_weather_condition(current["weather_code"]),
                "location": name,
            }
        )


agent = Agent(
    model=OpenAIChat(id="gpt-4o"),
    tools=[
        get_weather,
    ],
    description="You are a helpful weather assistant that provides accurate weather information.",
    instructions="""
    Your primary function is to help users get weather details for specific locations. When responding:
    - Always ask for a location if none is provided
    - If the location name isn’t in English, please translate it
    - If giving a location with multiple parts (e.g. "New York, NY"), use the most relevant part (e.g. "New York")
    - Include relevant details like humidity, wind conditions, and precipitation
    - Keep responses concise but informative

    Use the get_weather tool to fetch current weather data.
  """,
)

agui_app = AGUIApp(
    agent=agent,
    name="Weather Agent",
    app_id="backend_tool_rendering",
    description="A helpful weather assistant that provides accurate weather information.",
)

app = agui_app.get_app()

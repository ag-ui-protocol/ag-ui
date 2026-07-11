"""Backend tool rendering — a server-side ``@function_tool``.

Exercises ``TOOL_CALL_START/ARGS/END`` + ``TOOL_CALL_RESULT`` for a tool the
*backend* owns and executes (as opposed to :mod:`human_in_the_loop`, where the
frontend owns execution). The SDK runs the tool body itself; the translator
just reports the call and its result as they stream past.

The dojo's weather card (apps/dojo .../backend_tool_rendering/page.tsx) reads
the tool result as a JSON object — temperature/conditions/humidity/
wind_speed/feels_like — and the argument as `location`, matching every other
integration's version of this demo. A plain sentence string or a `city`
param renders as a blank/all-zero card, since the frontend has nothing to
parse.
"""

from __future__ import annotations

from agents import Agent, function_tool

from .constants import DEFAULT_MODEL

_WEATHER = {
    "berlin": {"temperature": 24, "conditions": "sunny", "humidity": 40, "wind_speed": 12, "feels_like": 25},
    "munich": {"temperature": 22, "conditions": "cloudy", "humidity": 55, "wind_speed": 8, "feels_like": 21},
    "london": {"temperature": 17, "conditions": "rainy", "humidity": 75, "wind_speed": 18, "feels_like": 16},
    "paris": {"temperature": 26, "conditions": "sunny", "humidity": 35, "wind_speed": 10, "feels_like": 27},
    "new york": {"temperature": 19, "conditions": "clear", "humidity": 45, "wind_speed": 14, "feels_like": 18},
    "san francisco": {"temperature": 16, "conditions": "cloudy", "humidity": 68, "wind_speed": 20, "feels_like": 15},
    "tokyo": {"temperature": 23, "conditions": "clear", "humidity": 60, "wind_speed": 9, "feels_like": 24},
}
_DEFAULT_WEATHER = {"temperature": 20, "conditions": "clear", "humidity": 50, "wind_speed": 10, "feels_like": 20}


@function_tool
def get_weather(location: str) -> dict:
    """Get the current weather for a location."""
    return _WEATHER.get(location.lower(), _DEFAULT_WEATHER)


def create_backend_tool_agent() -> Agent:
    return Agent(
        name="weather_assistant",
        model=DEFAULT_MODEL,
        instructions=(
            "You are a helpful weather assistant. Use the get_weather tool "
            "whenever the user asks about weather in a specific location."
        ),
        tools=[get_weather],
    )

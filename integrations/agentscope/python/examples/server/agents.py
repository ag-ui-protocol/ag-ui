"""Real AgentScope agents, with a deterministic model for offline qualification."""

import json
import os
from contextlib import asynccontextmanager
from uuid import uuid4

from ag_ui.core import RunAgentInput
from agentscope.agent import Agent
from agentscope.credential import OpenAICredential
from agentscope.message import (
    TextBlock,
    ToolCallBlock,
    ToolResultBlock,
    ToolResultState,
)
from agentscope.model import ChatResponse, FinishedReason, OpenAIChatModel
from agentscope.state import AgentState
from agentscope.tool import FunctionTool, ToolChunk, Toolkit


async def get_weather(location: str) -> ToolChunk:
    """Return illustrative weather data for a city; this is not a live forecast.

    Args:
        location: The city to display.
    """
    return ToolChunk(
        content=[
            TextBlock(
                text=json.dumps(
                    {
                        "location": location,
                        "temperature": 21,
                        "feels_like": 20,
                        "humidity": 65,
                        "wind_speed": 12,
                        "wind_gust": 18,
                        "conditions": "Mainly clear",
                    }
                )
            )
        ],
        state=ToolResultState.SUCCESS,
    )


class ScriptedModel(OpenAIChatModel):
    """Exercise AgentScope's actual streaming/tool loop without provider calls."""

    def __init__(self) -> None:
        super().__init__(
            credential=OpenAICredential(api_key="offline-placeholder"),
            model="scripted",
            max_retries=0,
        )

    async def _call_api(
        self, model_name, messages, tools=None, tool_choice=None, **kwargs
    ):
        latest_user = max(
            (index for index, message in enumerate(messages) if message.role == "user"),
            default=0,
        )
        question = messages[latest_user].content
        if not isinstance(question, str):
            question = "".join(
                block.text for block in question if isinstance(block, TextBlock)
            )
        results = [
            block
            for message in messages[latest_user + 1 :]
            for block in message.content
            if not isinstance(message.content, str)
            and isinstance(block, ToolResultBlock)
        ]
        weather_available = any(
            tool["function"]["name"] == "get_weather" for tool in tools or []
        )
        if weather_available and "weather" in question.lower() and not results:
            location = (
                "San Francisco" if "san francisco" in question.lower() else "Paris"
            )
            return ChatResponse(
                content=[
                    ToolCallBlock(
                        id=f"weather-{uuid4().hex}",
                        name="get_weather",
                        input=json.dumps({"location": location}),
                    )
                ],
                is_last=True,
            )

        answer = (
            "The illustrative forecast is 21°C with mainly clear skies."
            if results
            else "Hello! How can I help you today?"
        )

        async def stream():
            block_id = uuid4().hex
            for word in answer.split(" "):
                yield ChatResponse(
                    content=[TextBlock(id=block_id, text=word + " ")], is_last=False
                )
            yield ChatResponse(
                content=[TextBlock(id=block_id, text=answer + " ")],
                is_last=True,
                finished_reason=FinishedReason.COMPLETED,
            )

        return stream()


def agent_factory(*, with_weather: bool):
    @asynccontextmanager
    async def create(input_data: RunAgentInput):
        if os.getenv("AG_UI_AGENTSCOPE_OFFLINE") == "1":
            model = ScriptedModel()
        else:
            model = OpenAIChatModel(
                credential=OpenAICredential(
                    api_key=os.environ["OPENAI_API_KEY"],
                    base_url=os.getenv("OPENAI_BASE_URL"),
                ),
                model=os.getenv("OPENAI_MODEL", "gpt-4.1-mini"),
            )
        toolkit = Toolkit(
            tools=[FunctionTool(get_weather, is_read_only=True)] if with_weather else []
        )
        try:
            yield Agent(
                name="Assistant",
                system_prompt="You are a helpful assistant. Use get_weather for weather questions when available. Its results are illustrative, not a live forecast.",
                model=model,
                toolkit=toolkit,
                state=AgentState(session_id=input_data.thread_id),
            )
        finally:
            await model.client.close()

    return create

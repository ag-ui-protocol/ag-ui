"""
A simple agentic chat flow using LangGraph instead of CrewAI.
"""

from typing import List, Any, Optional
import os

# Updated imports for LangGraph
from langchain_core.runnables import RunnableConfig
from langchain_core.messages import SystemMessage
from langchain_core.tools import tool
from langchain_openai import ChatOpenAI
from langgraph.graph import StateGraph, END, START
from langgraph.graph import MessagesState
from langgraph.types import Command
from requests.api import get
from langgraph.prebuilt import create_react_agent


@tool
def get_weather(location: str):
    """
    Get the weather for a given location.
    """
    return {
        "temperature": 20,
        "conditions": "sunny",
        "humidity": 50,
        "wind_speed": 10,
        "feelsLike": 25,
    }


# Conditionally use a checkpointer based on the environment
# Check for multiple indicators that we're running in LangGraph dev/API mode
is_fast_api = os.environ.get("LANGGRAPH_FAST_API", "false").lower() == "true"

# Compile the graph
if is_fast_api:
    # For CopilotKit and other contexts, use MemorySaver
    from langgraph.checkpoint.memory import MemorySaver

    graph = create_react_agent(
        model="openai:gpt-4.1-mini",
        tools=[get_weather],
        prompt="You are a helpful assistant",
        checkpointer=MemorySaver(),
    )
else:
    # When running in LangGraph API/dev, don't use a custom checkpointer
    graph = create_react_agent(
        model="openai:gpt-4.1-mini",
        tools=[get_weather],
        prompt="You are a helpful assistant",
    )

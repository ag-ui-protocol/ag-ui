"""
A simple agentic chat flow using LangGraph instead of CrewAI.
"""

import os

from langchain.agents import create_agent
from langchain_core.tools import tool

from copilotkit import CopilotKitMiddleware, CopilotKitState

# Conditionally use a checkpointer based on the environment
# Check for multiple indicators that we're running in LangGraph dev/API mode
is_fast_api = os.environ.get("LANGGRAPH_FAST_API", "false").lower() == "true"

# Compile the graph
if is_fast_api:
    # For CopilotKit and other contexts, use MemorySaver
    from langgraph.checkpoint.memory import MemorySaver
    memory = MemorySaver()
    graph = create_agent(
        model="openai:gpt-4.1-mini",
        tools=[],  # Backend tools go here
        middleware=[CopilotKitMiddleware()],
        system_prompt="You are a helpful assistant.",
        checkpointer=memory,
        state_schema=CopilotKitState
    )
else:
    # When running in LangGraph API/dev, don't use a custom checkpointer
    graph = create_agent(
        model="openai:gpt-4.1-mini",
        tools=[],  # Backend tools go here
        middleware=[CopilotKitMiddleware()],
        system_prompt="You are a helpful assistant.",
        state_schema=CopilotKitState
    )

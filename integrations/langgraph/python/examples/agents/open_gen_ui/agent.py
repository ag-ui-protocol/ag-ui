"""
An open generative UI agent using LangGraph.
"""

import os

from langchain.agents import create_agent
from langchain_core.tools import tool
from copilotkit import CopilotKitMiddleware, CopilotKitState

SYSTEM_PROMPT = """You are an AI assistant that builds interactive UIs on demand.

When the user asks for any visual or interactive element, use the generateSandboxedUi tool to create it.
You can use CDN libraries like Chart.js, D3.js, Three.js, or x-data-spreadsheet to build rich UIs.

Be creative and build polished, well-styled interfaces. Always include proper CSS styling."""

# Conditionally use a checkpointer based on the environment
is_fast_api = os.environ.get("LANGGRAPH_FAST_API", "false").lower() == "true"

# Compile the graph
if is_fast_api:
    from langgraph.checkpoint.memory import MemorySaver
    memory = MemorySaver()
    graph = create_agent(
        model="openai:gpt-4.1",
        tools=[],
        middleware=[CopilotKitMiddleware()],
        system_prompt=SYSTEM_PROMPT,
        checkpointer=memory,
        state_schema=CopilotKitState
    )
else:
    graph = create_agent(
        model="openai:gpt-4.1",
        tools=[],
        middleware=[CopilotKitMiddleware()],
        system_prompt=SYSTEM_PROMPT,
        state_schema=CopilotKitState
    )

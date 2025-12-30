"""
A simple agentic chat flow using LangGraph instead of CrewAI.
"""

import os

from langchain.agents import create_agent
from langchain_core.tools import tool
from langgraph.checkpoint.memory import MemorySaver

from copilotkit import copilotkit_middleware

checkpointer = MemorySaver()

# Create agent with Copilotkit middleware
# Frontend tools are automatically handled via middleware
graph = create_agent(
    model="openai:gpt-4o",
    tools=[],  # Backend tools go here
    middleware=[copilotkit_middleware],
    system_prompt="You are a helpful assistant.",
)

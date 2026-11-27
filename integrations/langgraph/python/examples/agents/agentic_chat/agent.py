"""Export the stock chat graph for LangGraph Platform and local graph use."""

import os

from agents.agentic_chat.fastapi import create_chat_graph

graph = create_chat_graph(
    fastapi=os.environ.get("LANGGRAPH_FAST_API", "false").lower() == "true"
)

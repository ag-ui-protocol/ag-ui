"""Explicit Platform test lane using the actual AG-UI transformer."""
from agents.agentic_chat.agent import graph
from ag_ui_langgraph.transformer import agui_transformer

graph.stream_transformers = (agui_transformer,)

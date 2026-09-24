"""Existing Dojo journeys with the real AG-UI transformer enabled."""
from ag_ui_langgraph.transformer import agui_transformer
from agents.agentic_chat.agent import graph as agentic_chat
from agents.human_in_the_loop.agent import graph as human_in_the_loop
from agents.tool_based_generative_ui.agent import graph as tool_based_generative_ui

for graph in (agentic_chat, human_in_the_loop, tool_based_generative_ui):
    graph.stream_transformers = (agui_transformer,)

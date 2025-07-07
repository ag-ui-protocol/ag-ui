import os
import uvicorn
from fastapi import FastAPI

from dotenv import load_dotenv
load_dotenv()

from ag_ui_langgraph import LangGraphAgent, add_langgraph_fastapi_endpoint
from .human_in_the_loop import human_in_the_loop_graph
from .predictive_state_updates import predictive_state_updates_graph
from .shared_state import shared_state_graph
from .tool_based_generative_ui import tool_based_generative_ui_graph
from .agentic_chat import agentic_chat_graph
from .agentic_generative_ui import graph

app = FastAPI(title="LangGraph Dojo Example Server")

agents = {
    # Register the LangGraph agent using the LangGraphAgent class
    "agentic_chat": LangGraphAgent(
        name="agentic_chat",
        description="An example for an agentic chat flow using LangGraph.",
        graph=agentic_chat_graph
    ),
    "tool_based_generative_ui": LangGraphAgent(
        name="tool_based_generative_ui",
        description="An example for a tool-based generative UI flow.",
        graph=tool_based_generative_ui_graph,
    ),
    "agentic_generative_ui": LangGraphAgent(
        name="agentic_generative_ui",
        description="An example for an agentic generative UI flow.",
        graph=graph,
    ),
    "human_in_the_loop": LangGraphAgent(
        name="human_in_the_loop",
        description="An example for a human in the loop flow.",
        graph=human_in_the_loop_graph,
    ),
    "shared_state": LangGraphAgent(
        name="shared_state",
        description="An example for a shared state flow.",
        graph=shared_state_graph,
    ),
    "predictive_state_updates": LangGraphAgent(
        name="predictive_state_updates",
        description="An example for a predictive state updates flow.",
        graph=predictive_state_updates_graph,
    )
}

add_langgraph_fastapi_endpoint(
    app=app,
    agent=agents["agentic_chat"],
    path="/agent/agentic_chat"
)

add_langgraph_fastapi_endpoint(
    app=app,
    agent=agents["tool_based_generative_ui"],
    path="/agent/tool_based_generative_ui"
)

add_langgraph_fastapi_endpoint(
    app=app,
    agent=agents["agentic_generative_ui"],
    path="/agent/agentic_generative_ui"
)

add_langgraph_fastapi_endpoint(
    app=app,
    agent=agents["human_in_the_loop"],
    path="/agent/human_in_the_loop"
)

add_langgraph_fastapi_endpoint(
    app=app,
    agent=agents["shared_state"],
    path="/agent/shared_state"
)

add_langgraph_fastapi_endpoint(
    app=app,
    agent=agents["predictive_state_updates"],
    path="/agent/predictive_state_updates"
)

def main():
    """Run the uvicorn server."""
    port = int(os.getenv("PORT", "8000"))
    uvicorn.run(
        "agents.dojo:app",
        host="0.0.0.0",
        port=port,
        reload=True
    )

import os

import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI

load_dotenv()

os.environ["LANGGRAPH_FAST_API"] = "true"

from ag_ui_langgraph import LangGraphAgent, add_langgraph_fastapi_endpoint
from copilotkit import LangGraphAGUIAgent

from .agentic_chat.agent import graph as agentic_chat_graph
from .agentic_chat_reasoning.agent import graph as agentic_chat_reasoning_graph
from .agentic_generative_ui.agent import graph as agentic_generative_ui_graph
from .backend_tool_rendering.agent import graph as backend_tool_rendering_graph
from .human_in_the_loop.agent import graph as human_in_the_loop_graph
from .predictive_state_updates.agent import graph as predictive_state_updates_graph
from .shared_state.agent import graph as shared_state_graph
from .subgraphs.agent import graph as subgraphs_graph
from .a2ui_chat.agent import graph as a2ui_chat_graph
from .tool_based_generative_ui.agent import graph as tool_based_generative_ui_graph

app = FastAPI(title="LangGraph Dojo Example Server")

agents = {
    # Register the LangGraph agent using the LangGraphAgent class
    "agentic_chat": LangGraphAGUIAgent(
        name="agentic_chat",
        description="An example for an agentic chat flow using LangGraph.",
        graph=agentic_chat_graph,
    ),
    "backend_tool_rendering": LangGraphAgent(
        name="backend_tool_rendering",
        description="An example for a backend tool rendering flow.",
        graph=backend_tool_rendering_graph,
    ),
    "tool_based_generative_ui": LangGraphAgent(
        name="tool_based_generative_ui",
        description="An example for a tool-based generative UI flow.",
        graph=tool_based_generative_ui_graph,
    ),
    "agentic_generative_ui": LangGraphAgent(
        name="agentic_generative_ui",
        description="An example for an agentic generative UI flow.",
        graph=agentic_generative_ui_graph,
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
    ),
    "agentic_chat_reasoning": LangGraphAgent(
        name="agentic_chat_reasoning",
        description="An example for a reasoning chat.",
        graph=agentic_chat_reasoning_graph,
    ),
    "subgraphs": LangGraphAgent(
        name="subgraphs",
        description="A demo of LangGraph subgraphs using a Game Character Creator.",
        graph=subgraphs_graph,
    ),
    "a2ui_chat": LangGraphAgent(
        name="a2ui_chat",
        description="An agent that can render A2UI surfaces.",
        graph=a2ui_chat_graph,
    ),
}

add_langgraph_fastapi_endpoint(
    app=app, agent=agents["agentic_chat"], path="/agent/agentic_chat"
)

add_langgraph_fastapi_endpoint(
    app=app,
    agent=agents["backend_tool_rendering"],
    path="/agent/backend_tool_rendering",
)


add_langgraph_fastapi_endpoint(
    app=app,
    agent=agents["tool_based_generative_ui"],
    path="/agent/tool_based_generative_ui",
)

add_langgraph_fastapi_endpoint(
    app=app, agent=agents["agentic_generative_ui"], path="/agent/agentic_generative_ui"
)

add_langgraph_fastapi_endpoint(
    app=app, agent=agents["human_in_the_loop"], path="/agent/human_in_the_loop"
)

add_langgraph_fastapi_endpoint(
    app=app, agent=agents["shared_state"], path="/agent/shared_state"
)

add_langgraph_fastapi_endpoint(
    app=app,
    agent=agents["predictive_state_updates"],
    path="/agent/predictive_state_updates",
)

add_langgraph_fastapi_endpoint(
    app=app,
    agent=agents["agentic_chat_reasoning"],
    path="/agent/agentic_chat_reasoning",
)

add_langgraph_fastapi_endpoint(
    app=app, agent=agents["subgraphs"], path="/agent/subgraphs"
)

add_langgraph_fastapi_endpoint(
    app=app, agent=agents["a2ui_chat"], path="/agent/a2ui_chat"
)


def main():
    """Run the uvicorn server."""
    port = int(os.getenv("PORT", "8000"))
    uvicorn.run("agents.dojo:app", host="0.0.0.0", port=port, reload=True)

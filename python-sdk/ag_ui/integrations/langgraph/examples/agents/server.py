"""
This serves our agents through a FastAPI server.
"""

import os
from dotenv import load_dotenv
load_dotenv() # pylint: disable=wrong-import-position

from fastapi import FastAPI, HTTPException, Request
import uvicorn
from ag_ui.core.types import RunAgentInput
from ag_ui.integrations.langgraph import LangGraphAgent
from fastapi.responses import StreamingResponse
from ag_ui.encoder import EventEncoder

# Import all agent examples
from .human_in_the_loop.agent import human_in_the_loop_graph
from .predictive_state_updates.agent import predictive_state_updates_graph
from .shared_state.agent import shared_state_graph
from .tool_based_generative_ui.agent import tool_based_generative_ui_graph
from .agentic_chat.agent import agentic_chat_graph
from .agentic_generative_ui.agent import graph

app = FastAPI()

def create_agents(context):
    return {
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

@app.post("/agent/{agent_id}")
async def run_agent_endpoint(agent_id: str, input_data: RunAgentInput, request: Request):
    """Agentic chat endpoint"""
    # Get the accept header from the request
    accept_header = request.headers.get("accept")

    # Create an event encoder to properly format SSE events
    encoder = EventEncoder(accept=accept_header)

    agents = create_agents({})
    agent = agents.get(agent_id)
    if not agent:
        raise HTTPException(status_code=404, detail=f"Agent {agent_id} not found")

    async def event_generator():
        async for event in agent.run(input_data, encoder):
            yield event  # Events are already encoded by the agent

    return StreamingResponse(
        event_generator(),
        media_type=encoder.get_content_type()
    )



def main():
    """Run the uvicorn server."""
    port = int(os.getenv("PORT", "8000"))
    uvicorn.run(
        "agents.server:app",
        host="0.0.0.0",
        port=port,
        reload=True,
    )

if __name__ == "__main__":
    main()

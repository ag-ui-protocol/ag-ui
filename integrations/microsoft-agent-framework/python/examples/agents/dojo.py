"""Microsoft Agent Framework Python Dojo Example Server.

This provides a FastAPI application that demonstrates how to use the
Microsoft Agent Framework with the AG-UI protocol. It includes examples for
each of the AG-UI dojo features:
- Agentic Chat
- Human in the Loop
- Backend Tool Rendering
- Agentic Generative UI
- Tool-based Generative UI
- Shared State
- Predictive State Updates

All agent implementations are from the agent-framework-ag-ui package examples.
Reference: https://github.com/microsoft/agent-framework/tree/main/python/packages/ag-ui/examples/agents
"""

import os
import uvicorn
from fastapi import FastAPI
from dotenv import load_dotenv

from agent_framework_ag_ui import add_agent_framework_fastapi_endpoint
from agent_framework_ag_ui_examples.agents import (
    simple_agent,
    weather_agent,
    human_in_the_loop_agent,
    task_steps_agent_wrapped,
    ui_generator_agent,
    recipe_agent,
    document_writer_agent,
)

load_dotenv()

app = FastAPI(title="Microsoft Agent Framework Python Dojo")

# Agentic Chat - simple_agent
add_agent_framework_fastapi_endpoint(app, simple_agent, "/agentic_chat")

# Backend Tool Rendering - weather_agent
add_agent_framework_fastapi_endpoint(app, weather_agent, "/backend_tool_rendering")

# Human in the Loop - human_in_the_loop_agent with state configuration
add_agent_framework_fastapi_endpoint(
    app,
    human_in_the_loop_agent,
    "/human_in_the_loop",
)

# Agentic Generative UI - task_steps_agent_wrapped
add_agent_framework_fastapi_endpoint(app, task_steps_agent_wrapped, "/agentic_generative_ui")

# Tool-based Generative UI - ui_generator_agent
add_agent_framework_fastapi_endpoint(app, ui_generator_agent, "/tool_based_generative_ui")

# Shared State - recipe_agent
add_agent_framework_fastapi_endpoint(app, recipe_agent, "/shared_state")

# Predictive State Updates - document_writer_agent
add_agent_framework_fastapi_endpoint(app, document_writer_agent, "/predictive_state_updates")


def main():
    """Main function to start the FastAPI server."""
    port = int(os.getenv("PORT", "8888"))
    uvicorn.run(app, host="0.0.0.0", port=port)


if __name__ == "__main__":
    main()


__all__ = ["main"]

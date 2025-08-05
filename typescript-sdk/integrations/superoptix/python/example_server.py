"""
Example SuperOptiX AG-UI server.
"""
import os
import uvicorn
from pathlib import Path
from fastapi import FastAPI
from dotenv import load_dotenv

from ag_ui_superoptix.endpoint import add_superoptix_fastapi_endpoint

load_dotenv()

app = FastAPI(title="SuperOptiX AG-UI Server")

# Use the proper SuperOptiX project structure
# Point to the swe project root where the .super file is located
project_root = Path("/Users/shashi/superagentic/SuperOptiX/swe")

# Add SuperOptiX endpoints for different features
# The agent name should match what's available in the project
add_superoptix_fastapi_endpoint(
    app, 
    agent_name="developer",  # This should match the agent name in swe/swe/agents/
    project_root=project_root,
    path="/agentic_chat"
)

add_superoptix_fastapi_endpoint(
    app, 
    agent_name="developer",  # This should match the agent name in swe/swe/agents/
    project_root=project_root,
    path="/human_in_the_loop"
)

add_superoptix_fastapi_endpoint(
    app, 
    agent_name="developer",  # This should match the agent name in swe/swe/agents/
    project_root=project_root,
    path="/tool_based_generative_ui"
)

add_superoptix_fastapi_endpoint(
    app, 
    agent_name="developer",  # This should match the agent name in swe/swe/agents/
    project_root=project_root,
    path="/agentic_generative_ui"
)

add_superoptix_fastapi_endpoint(
    app, 
    agent_name="developer",  # This should match the agent name in swe/swe/agents/
    project_root=project_root,
    path="/shared_state"
)

add_superoptix_fastapi_endpoint(
    app, 
    agent_name="developer",  # This should match the agent name in swe/swe/agents/
    project_root=project_root,
    path="/predictive_state_updates"
)

def main():
    """Run the uvicorn server."""
    port = int(os.getenv("PORT", "8000"))
    uvicorn.run(
        "example_server:app",
        host="0.0.0.0",
        port=port,
        reload=True
    )

if __name__ == "__main__":
    main() 
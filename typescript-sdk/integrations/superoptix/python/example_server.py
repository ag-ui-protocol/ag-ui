"""
Example SuperOptiX AG-UI server.

SETUP INSTRUCTIONS:
1. Install SuperOptiX: pip install superoptix
2. Create a SuperOptiX project: super init swe
3. Pull and compile an agent: 
   cd swe
   super agent pull developer
   super agent compile developer
4. Update the PROJECT_ROOT path below to point to your project
5. Run this server: python example_server.py
"""
import os
import uvicorn
from pathlib import Path
from fastapi import FastAPI
from dotenv import load_dotenv

from ag_ui_superoptix.endpoint import add_superoptix_fastapi_endpoint

load_dotenv()

app = FastAPI(title="SuperOptiX AG-UI Server")

# CONFIGURATION: Update this path to point to your SuperOptiX project
# The project should contain a .super file and agents directory
PROJECT_ROOT = Path("/path/to/your/superoptix/project")  # UPDATE THIS PATH

# Example paths (uncomment one):
# PROJECT_ROOT = Path("/Users/username/superoptix/swe")  # macOS/Linux
# PROJECT_ROOT = Path("C:/Users/username/superoptix/swe")  # Windows
# PROJECT_ROOT = Path(__file__).parent.parent / "swe"  # Relative to this file

# Verify the project exists
if not PROJECT_ROOT.exists():
    raise FileNotFoundError(
        f"SuperOptiX project not found at {PROJECT_ROOT}. "
        "Please update PROJECT_ROOT in this file to point to your SuperOptiX project. "
        "See setup instructions at the top of this file."
    )

if not (PROJECT_ROOT / ".super").exists():
    raise FileNotFoundError(
        f"SuperOptiX project at {PROJECT_ROOT} is missing .super file. "
        "Please ensure you ran 'super init' and 'super agent pull developer'."
    )

# Add SuperOptiX endpoints for different features
# The agent name should match what's available in your project
AGENT_NAME = "developer"  # Update this to match your agent name

add_superoptix_fastapi_endpoint(
    app, 
    agent_name=AGENT_NAME,
    project_root=PROJECT_ROOT,
    path="/agentic_chat"
)

add_superoptix_fastapi_endpoint(
    app, 
    agent_name=AGENT_NAME,
    project_root=PROJECT_ROOT,
    path="/human_in_the_loop"
)

add_superoptix_fastapi_endpoint(
    app, 
    agent_name=AGENT_NAME,
    project_root=PROJECT_ROOT,
    path="/tool_based_generative_ui"
)

add_superoptix_fastapi_endpoint(
    app, 
    agent_name=AGENT_NAME,
    project_root=PROJECT_ROOT,
    path="/agentic_generative_ui"
)

add_superoptix_fastapi_endpoint(
    app, 
    agent_name=AGENT_NAME,
    project_root=PROJECT_ROOT,
    path="/shared_state"
)

add_superoptix_fastapi_endpoint(
    app, 
    agent_name=AGENT_NAME,
    project_root=PROJECT_ROOT,
    path="/predictive_state_updates"
)

def main():
    """Run the uvicorn server."""
    port = int(os.getenv("PORT", "8000"))
    print(f"🚀 Starting SuperOptiX AG-UI server on http://localhost:{port}")
    print(f"📁 Using SuperOptiX project: {PROJECT_ROOT}")
    print(f"🤖 Using agent: {AGENT_NAME}")
    uvicorn.run(
        "example_server:app",
        host="0.0.0.0",
        port=port,
        reload=True
    )

if __name__ == "__main__":
    main() 